import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow } from '@xyflow/react';
import type { FitViewOptions, NodeChange, NodeMouseHandler, OnNodeDrag } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { AnimatedMoonrayMark } from '../components/Icons.js';
import { useTheme } from '../hooks/useTheme.js';
import {
  emptyFilter, filterOptions, isFilterActive, matchesFilter, normalizeSensitivity, toggleFilterValue,
} from './kg-filters.js';
import type { KgFilter, KgFilterAxis, KgFilterable } from './kg-filters.js';
import { TYPE_BADGE, SENS_BADGE } from './kg-types.js';
import type { ApiKgNode } from './kg-types.js';
import { MergeNodesDialog } from './MergeNodesDialog.js';
import type { NodeMergeResult } from './kg-merge-types.js';
import {
  applyMergeToNodeList, mergeAvailability, mergedIntoFrom, mergedIntoNotice, mergeResultNotes, mergeSuccessMessage,
} from './kg-merge-utils.js';
import {
  addToModel, applyPositions, buildFlow, closedNeighborhood, drawerNode, emptyFlowCache, emptyModel, facets,
  graphStatus, layoutRequest, modelFrom, removeNode,
} from './kg-graph-model.js';
import type { ApiKgEdge, ColorMode, KgFlowEdge, KgFlowNode } from './kg-graph-model.js';
import { KG_EDGE_TYPES, KG_NODE_TYPES, ZoomLevelClass } from './kg-graph-view.js';
import { createLayoutClient } from './kg-layout-client.js';
import type { LayoutClient } from './kg-layout-client.js';

// The graph is drawn with xyflow; layout runs in a Web Worker (ADR-058).

// ── Types ─────────────────────────────────────────────────────────────────────

/** The page banner after a merge or a merged-node redirect. */
interface KgBanner {
  text: string;
  /** Follow-up notes (post-commit merge warnings); the banner turns amber when present. */
  notes?: string[];
}

/** A single click waits this long so a double-click (zoom to the node) does not also expand it. */
const DOUBLE_CLICK_MS = 250;

/** Automatic fits stop here, so a small graph is not blown up to fill the canvas. */
const FIT_MAX_ZOOM = 1.25;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

// A /api/kg/graph 404 body: the message to show, and the survivor when the node
// was merged away (`code: 'node_merged'`, design §10.4).
async function notFoundInfo(res: Response): Promise<{ message: string; merged: ReturnType<typeof mergedIntoFrom> }> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: unknown };
      return {
        message: typeof d.error === 'string' && d.error ? d.error : `HTTP ${res.status}`,
        merged: mergedIntoFrom(d),
      };
    } catch (err) {
      console.error('[notFoundInfo] failed to parse JSON error body:', err);
    }
  }
  return { message: `HTTP ${res.status}`, merged: null };
}

// How many merged-into redirects a single load follows before giving up — a
// guard against a (corrupt) merged_into cycle.
const MAX_MERGE_REDIRECTS = 3;

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

// ── Node detail drawer ────────────────────────────────────────────────────────

interface NodeDetailDrawerProps {
  node: ApiKgNode;
  onClose: () => void;
  onMerge: () => void;
}

function NodeDetailDrawer({ node, onClose, onMerge }: NodeDetailDrawerProps) {
  const typeBadgeClass = TYPE_BADGE[node.type] ?? 'badge badge-kg-fact';
  const sensBadgeClass = SENS_BADGE[node.sensitivity] ?? 'badge badge-kg-internal';
  const propEntries = Object.entries(node.properties ?? {});
  const merge = mergeAvailability(node);

  return (
    <div className="kg-detail-drawer">
      <div className="kg-detail-header">
        <div className="kg-detail-header-top">
          <div className="kg-detail-badges">
            <span className={typeBadgeClass}>{node.type}</span>
            <span className={sensBadgeClass}>{node.sensitivity}</span>
          </div>
          <button
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="kg-detail-title">{node.label || '(no label)'}</h2>
      </div>

      <div className="kg-detail-body">
        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Confidence</div>
          <div className="kg-detail-field-value mono">
            {node.confidence != null ? node.confidence.toFixed(3) : '—'}
          </div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Decay class</div>
          <div className="kg-detail-field-value">{node.decayClass || '—'}</div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Source</div>
          <div className="kg-detail-field-value mono">{node.source || '—'}</div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Created</div>
          <div className="kg-detail-field-value">{fmtDate(node.createdAt)}</div>
        </div>

        <div className="kg-detail-field">
          <div className="kg-detail-field-label">Last confirmed</div>
          <div className="kg-detail-field-value">{fmtDate(node.lastConfirmedAt)}</div>
        </div>

        {propEntries.length > 0 && (
          <div className="kg-detail-field">
            <div className="kg-detail-field-label">Properties</div>
            <table className="kg-props-table">
              <tbody>
                {propEntries.map(([key, val]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>
                      {val !== null && val !== undefined
                        ? (typeof val === 'object' ? JSON.stringify(val) : String(val))
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {merge.visible && (
        <div className="drawer-footer">
          <button
            className="btn btn-secondary btn-sm"
            onClick={onMerge}
            disabled={merge.disabled}
            title={merge.reason ?? 'Merge this node with a duplicate'}
          >
            Merge…
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function KgPage() {
  // useReactFlow (fitView) needs the provider above the component that calls it.
  return (
    <ReactFlowProvider>
      <KgPageInner />
    </ReactFlowProvider>
  );
}

function KgPageInner() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const { fitView } = useReactFlow<KgFlowNode, KgFlowEdge>();

  // Read initial search params — used to restore state on refresh/back-nav.
  const { q: initialQ, node: initialNode } = useSearch({ strict: false }) as {
    q?: string;
    node?: string;
  };

  // Graph canvas. The model is what is on the canvas; rfNodes/rfEdges are rebuilt from it
  // whenever it (graphVersion) or how it is shown (colour, filter, focal, selection) changes.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef(emptyModel());
  const flowCacheRef = useRef(emptyFlowCache());
  const [graphVersion, setGraphVersion] = useState(0);
  const [rfNodes, setRfNodes] = useState<KgFlowNode[]>([]);
  const [rfEdges, setRfEdges] = useState<KgFlowEdge[]>([]);
  const [focalId, setFocalId] = useState<string | null>(null);
  // Layout: one request per render/expansion; a newer request makes older answers stale.
  const layoutRef = useRef<LayoutClient | null>(null);
  const layoutSeqRef = useRef(0);
  // Viewport fit to apply once the nodes from the latest layout are on the canvas.
  const pendingFitRef = useRef<FitViewOptions<KgFlowNode> | null>(null);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Moonray loader while the canvas waits on the server or the layout. Each wait gets a
  // sequence number so an older one finishing late does not hide a newer one's loader.
  const busySeqRef = useRef(0);
  const [busy, setBusy] = useState<{ seq: number; kind: 'load' | 'expand' } | null>(null);
  const [sidebarLoading, setSidebarLoading] = useState(false);

  // UI state
  const [sidebarNodes, setSidebarNodes] = useState<ApiKgNode[]>([]);
  const [search, setSearch] = useState(initialQ ?? '');
  const [selectedNode, setSelectedNode] = useState<ApiKgNode | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [filter, setFilter] = useState<KgFilter>(emptyFilter);
  // type/sensitivity of every node on the canvas — feeds the filter checklists.
  const [canvasFacets, setCanvasFacets] = useState<KgFilterable[]>([]);
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Node merge (#2233): the node the dialog was opened from, and the page banner
  // shown after a merge or a merged-node redirect.
  const [mergeFrom, setMergeFrom] = useState<ApiKgNode | null>(null);
  const [banner, setBanner] = useState<KgBanner | null>(null);

  // The filter in a ref so async loads apply the current filter to the status line.
  const filterRef = useRef<KgFilter>(emptyFilter());

  // Mirror search state in a ref so async handlers read the current value.
  const searchRef = useRef(initialQ ?? '');

  // Aborts the previous neighborhood fetch when a new one starts, preventing
  // stale responses from overwriting the canvas after rapid clicks.
  const neighborhoodAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  // Layout worker for the page's lifetime; in-flight work is dropped on unmount.
  useEffect(() => {
    const client = createLayoutClient();
    layoutRef.current = client;
    return () => {
      client.dispose();
      layoutRef.current = null;
      neighborhoodAbortRef.current?.abort();
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    };
  }, []);

  // Rebuild what xyflow draws. Unchanged nodes keep their object (flow cache), so their
  // memoised components skip re-rendering.
  const selectedId = selectedNode?.id ?? null;
  useEffect(() => {
    const { nodes, edges } = buildFlow(
      modelRef.current, { colorMode, filter, focalId, selectedId }, flowCacheRef.current,
    );
    setRfNodes(nodes);
    setRfEdges(edges);
  }, [graphVersion, colorMode, filter, focalId, selectedId]);

  // Apply a queued viewport fit once the new nodes are drawn (xyflow queues the fit
  // itself until they are measured).
  useEffect(() => {
    const fit = pendingFitRef.current;
    if (!fit) return;
    pendingFitRef.current = null;
    void fitView(fit);
  }, [rfNodes, fitView]);

  // Sync URL search params on search/node changes.
  function syncUrl(q: string, nodeId: string | undefined) {
    navigate({
      to: '/kg',
      search: { q: q || undefined, node: nodeId },
      replace: true,
    }).catch(err => {
      console.error('[KgPage] URL sync failed:', err);
    });
  }

  /** Shows the loader; call the returned function when the wait is over. */
  function beginBusy(kind: 'load' | 'expand'): () => void {
    const seq = ++busySeqRef.current;
    setBusy({ seq, kind });
    return () => setBusy(b => (b && b.seq === seq ? null : b));
  }

  function syncFacets() {
    setCanvasFacets(facets(modelRef.current));
  }

  /**
   * Lays out the model and redraws. Resolves false when a newer layout superseded this one
   * or the layout failed (the status line says so); the model itself is kept either way.
   */
  async function runLayout(mode: 'full' | 'expand', opts: { anchorId?: string; fit?: () => FitViewOptions<KgFlowNode> } = {}): Promise<boolean> {
    const client = layoutRef.current;
    if (!client) return false;
    const seq = ++layoutSeqRef.current;
    const res = await client.run(layoutRequest(modelRef.current, seq, mode, opts.anchorId));
    if (seq !== layoutSeqRef.current) return false;
    if (!res.ok) {
      console.error('[KgPage] layout failed:', res.error);
      setStatus(`Layout failed: ${res.error}`);
      return false;
    }
    applyPositions(modelRef.current, res.positions);
    if (opts.fit) pendingFitRef.current = opts.fit();
    setGraphVersion(v => v + 1);
    return true;
  }

  // ── Sidebar node search ────────────────────────────────────────────────────

  const loadSidebarNodes = useCallback(async (q: string) => {
    setLoadError(null);
    setSidebarLoading(true);
    try {
      const url = q
        ? `/api/kg/nodes?query=${encodeURIComponent(q)}&limit=100`
        : '/api/kg/nodes?limit=100';
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[] };
      setSidebarNodes(data.nodes);
    } catch (err) {
      console.error('[KgPage] sidebar load failed:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load nodes');
    } finally {
      setSidebarLoading(false);
    }
  }, []);

  // ── Full graph replacement ─────────────────────────────────────────────────

  /**
   * Replaces the canvas. With `focusId`, the view then fits that node and its neighbours;
   * otherwise it fits the whole graph.
   */
  async function renderGraph(payload: { nodes: ApiKgNode[]; edges: ApiKgEdge[] }, focusId?: string): Promise<boolean> {
    modelRef.current = modelFrom(payload);
    syncFacets();
    return runLayout('full', {
      fit: () => {
        const m = modelRef.current;
        if (focusId && m.nodes.has(focusId)) {
          return { nodes: closedNeighborhood(m, focusId).map(id => ({ id })), padding: '110px', duration: 300, maxZoom: FIT_MAX_ZOOM };
        }
        return { padding: 0.1, maxZoom: FIT_MAX_ZOOM };
      },
    });
  }

  // ── Hero graph (default view when canvas is empty) ─────────────────────────

  async function loadHeroGraph() {
    if (modelRef.current.nodes.size > 0) return;
    neighborhoodAbortRef.current?.abort();
    const controller = new AbortController();
    neighborhoodAbortRef.current = controller;
    setStatus('Loading…');
    const done = beginBusy('load');
    try {
      const res = await apiFetch('/api/kg/graph?limit=20', { signal: controller.signal });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[]; edges: ApiKgEdge[] };
      if (controller.signal.aborted) return;
      await renderGraph(data);
      if (controller.signal.aborted) return;
      setStatus(graphStatus(modelRef.current, filterRef.current));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[KgPage] hero graph load failed:', err);
      setStatus(`Failed to load graph: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      done();
    }
  }

  // ── Load a node's neighborhood and replace canvas ─────────────────────────

  type NeighborhoodLoadResult =
    | { ok: true }
    | { ok: false; aborted: true }
    | { ok: false; aborted?: false; notFoundMessage?: string };

  /**
   * Returns ok:false when the node was not found (or the load failed before render).
   * A node that was merged away is followed to its survivor (§10.4).
   */
  async function loadNeighborhood(nodeId: string, redirects = 0): Promise<NeighborhoodLoadResult> {
    neighborhoodAbortRef.current?.abort();
    const controller = new AbortController();
    neighborhoodAbortRef.current = controller;
    setStatus('Loading…');
    const done = beginBusy('load');
    try {
      const res = await apiFetch(
        `/api/kg/graph?node_id=${encodeURIComponent(nodeId)}&depth=2`,
        { signal: controller.signal },
      );
      if (res.status === 404) {
        // Drop the dead deep-link so refresh does not re-hit the same 404 (#1881).
        const { message: notFoundMessage, merged } = await notFoundInfo(res);
        // Body read can lose a race with a newer click that aborted this controller.
        if (controller.signal.aborted) return { ok: false, aborted: true };
        if (merged && merged.mergedInto !== nodeId && redirects < MAX_MERGE_REDIRECTS) {
          // Name the node the user opened, not an intermediate hop of a chain
          // (expandNeighborhood sets its own notice before redirecting).
          if (redirects === 0) {
            const label = merged.label ?? modelRef.current.nodes.get(nodeId)?.label ?? null;
            setBanner({ text: mergedIntoNotice(label) });
          }
          return loadNeighborhood(merged.mergedInto, redirects + 1);
        }
        setSelectedNode(null);
        syncUrl(searchRef.current, undefined);
        setStatus(notFoundMessage);
        return { ok: false, notFoundMessage };
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[]; edges: ApiKgEdge[] };
      if (controller.signal.aborted) return { ok: false, aborted: true };
      // Draws the neighbourhood, then fits the view to the focal node and its neighbours.
      await renderGraph(data, nodeId);
      if (controller.signal.aborted) return { ok: false, aborted: true };
      // Sync selection + URL so refresh and back-nav restore this view.
      const focused = data.nodes.find(n => n.id === nodeId) ?? null;
      setSelectedNode(focused);
      syncUrl(searchRef.current, focused?.id);
      setFocalId(focused?.id ?? null);
      setStatus(graphStatus(modelRef.current, filterRef.current));
      return { ok: true };
    } catch (err) {
      // Another load took over neighborhoodAbortRef — do not hero-fallback (#1881 review).
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { ok: false, aborted: true };
      }
      console.error('[KgPage] neighborhood load failed:', err);
      setStatus(`Failed to load: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return { ok: false };
    } finally {
      done();
    }
  }

  // ── In-place expansion (single click on a canvas node) ─────────────────────

  async function expandNeighborhood(nodeId: string) {
    neighborhoodAbortRef.current?.abort();
    const controller = new AbortController();
    neighborhoodAbortRef.current = controller;
    setStatus('Expanding…');
    const done = beginBusy('expand');
    try {
      const res = await apiFetch(
        `/api/kg/graph?node_id=${encodeURIComponent(nodeId)}&depth=1`,
        { signal: controller.signal },
      );
      if (res.status === 404) {
        // The click already selected this node and wrote ?node= — clear the stale
        // node, selection, and URL so the user cannot re-click the same dead id (#1881).
        const { message: notFoundMessage, merged } = await notFoundInfo(res);
        if (controller.signal.aborted) return;
        const m = modelRef.current;
        const staleLabel = m.nodes.get(nodeId)?.label ?? null;
        removeNode(m, nodeId);
        syncFacets();
        setGraphVersion(v => v + 1);
        if (merged && merged.mergedInto !== nodeId) {
          // Merged since the canvas loaded: follow it to the survivor.
          setBanner({ text: mergedIntoNotice(merged.label ?? staleLabel) });
          void loadNeighborhood(merged.mergedInto, 1);
          return;
        }
        setSelectedNode(null);
        syncUrl(searchRef.current, undefined);
        setStatus(notFoundMessage);
        return;
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { nodes: ApiKgNode[]; edges: ApiKgEdge[] };
      if (controller.signal.aborted) return;

      setFocalId(nodeId);
      const added = addToModel(modelRef.current, data);
      if (added.nodes + added.edges > 0) {
        syncFacets();
        // Warm start: existing nodes start where they are and the graph re-settles
        // around them; new nodes start next to the node that was expanded.
        await runLayout('expand', { anchorId: nodeId });
      }
      if (controller.signal.aborted) return;
      setStatus(graphStatus(modelRef.current, filterRef.current));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[KgPage] expand failed:', err);
      setStatus(`Failed to expand: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      done();
    }
  }

  // ── Canvas events ──────────────────────────────────────────────────────────

  function handleNodeTap(nodeId: string) {
    const n = modelRef.current.nodes.get(nodeId);
    if (!n) return;
    // A merge/redirect notice describes the node it was shown for — drop it when the
    // user opens another one. A redirect from this click sets its own notice afterwards.
    setBanner(null);
    void expandNeighborhood(nodeId);
    setSelectedNode(drawerNode(n));
    syncUrl(searchRef.current, nodeId);
  }

  // A single click expands the node, after a short wait so a double-click (zoom to the
  // node and its neighbours) does not also expand it.
  const onNodeClick: NodeMouseHandler<KgFlowNode> = (_e, node) => {
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      handleNodeTap(node.id);
    }, DOUBLE_CLICK_MS);
  };

  const onNodeDoubleClick: NodeMouseHandler<KgFlowNode> = (_e, node) => {
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = null;
    const ids = closedNeighborhood(modelRef.current, node.id);
    void fitView({ nodes: ids.map(id => ({ id })), padding: '60px', duration: 300, maxZoom: FIT_MAX_ZOOM });
  };

  // xyflow reports drags and measurements; selection is driven by the page, not by xyflow.
  const onNodesChange = useCallback((changes: NodeChange<KgFlowNode>[]) => {
    const relevant = changes.filter(c => c.type === 'position' || c.type === 'dimensions');
    if (relevant.length > 0) setRfNodes(ns => applyNodeChanges(relevant, ns));
  }, []);

  // Keep dragged positions so later redraws and expansions start from them.
  const onNodeDragStop: OnNodeDrag<KgFlowNode> = (_e, _node, dragged) => {
    for (const n of dragged) {
      modelRef.current.pos.set(n.id, { x: n.position.x + n.data.size / 2, y: n.position.y + n.data.size / 2 });
    }
  };

  // ── On mount: load sidebar + hero graph, restore ?node= if present ─────────

  useEffect(() => {
    void loadSidebarNodes(initialQ ?? '');

    if (initialNode) {
      // Restore ?node= from URL via loadNeighborhood, which handles render,
      // focal node, viewport centering, and URL sync in one shot. On 404 the
      // dead id is cleared from the URL; fall back to the hero graph so the
      // user sees a graph with the not-found status rather than a blank canvas (#1881).
      // Skip fallback when this load was aborted by a newer click (do not steal the canvas).
      void (async () => {
        const result = await loadNeighborhood(initialNode);
        if (!result.ok && !result.aborted && result.notFoundMessage) {
          await loadHeroGraph();
          // loadHeroGraph overwrites status — restore the actionable not-found message.
          setStatus(result.notFoundMessage);
        }
      })();
    } else {
      // Default view: focus on the principal's KG node so the graph opens on
      // a meaningful starting point. Falls back to the hero graph if the
      // principal has no linked KG node or the contacts fetch fails.
      void (async () => {
        try {
          const res = await apiFetch('/api/contacts');
          if (res.ok) {
            const { contacts } = await res.json() as { contacts: Array<{
              systemRole: string | null;
              kgNodeId: string | null;
            }> };
            const principal = contacts.find(c => c.systemRole === 'principal');
            if (principal?.kgNodeId) {
              const result = await loadNeighborhood(principal.kgNodeId);
              // Success, or aborted because the user already started another load — leave it.
              if (result.ok || result.aborted) return;
            }
          } else {
            console.error('[KgPage] principal node lookup: contacts fetch failed with status', res.status);
          }
        } catch (err) {
          console.error('[KgPage] principal node lookup failed:', err);
        }
        void loadHeroGraph();
      })();
    }
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Color mode toggle ──────────────────────────────────────────────────────

  function handleColorMode(mode: ColorMode) {
    setColorMode(mode);
  }

  // ── Filter panel ───────────────────────────────────────────────────────────

  function updateFilter(next: KgFilter) {
    setFilter(next);
    filterRef.current = next;
    setStatus(graphStatus(modelRef.current, next));
  }

  const options = filterOptions(canvasFacets, filter);
  const filterActive = isFilterActive(filter);
  // Search results respect the filter too, so the list never offers a node
  // the canvas would hide.
  const visibleSidebarNodes = sidebarNodes.filter(n =>
    matchesFilter({ type: n.type, sensitivity: normalizeSensitivity(n.sensitivity) }, filter));

  function renderFilterAxis(axis: KgFilterAxis, legend: string, opts: typeof options.types) {
    return (
      <fieldset className="kg-filter-axis">
        <legend>{legend}</legend>
        {opts.map(opt => (
          <label key={opt.value} className="kg-filter-option">
            <input
              type="checkbox"
              checked={filter[axis].has(opt.value)}
              onChange={() => updateFilter(toggleFilterValue(filterRef.current, axis, opt.value))}
            />
            <span className="kg-filter-option-name">{opt.value}</span>
            <span className="kg-filter-option-count">{opt.count}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  // ── Sidebar search ─────────────────────────────────────────────────────────

  function handleSearch(q: string) {
    setSearch(q);
    searchRef.current = q;
  }

  function submitSearch() {
    syncUrl(search, selectedNode?.id);
    void loadSidebarNodes(search);
  }

  // ── Node merge (#2233) ─────────────────────────────────────────────────────

  async function handleMerged(result: NodeMergeResult, labels: { absorbed: string; survivor: string }) {
    setMergeFrom(null);
    setSidebarNodes(prev => applyMergeToNodeList(prev, result));
    const notes = mergeResultNotes(result.warnings);
    setBanner({ text: mergeSuccessMessage(labels.absorbed, labels.survivor), ...(notes.length > 0 ? { notes } : {}) });
    // Take the archived node off the canvas now (its edges go with it), so it
    // is gone even if the reload below fails.
    const m = modelRef.current;
    removeNode(m, result.absorbedId);
    const survivor = m.nodes.get(result.survivorId);
    if (survivor) m.nodes.set(result.survivorId, { ...survivor, label: result.node.label });
    syncFacets();
    setGraphVersion(v => v + 1);
    setStatus(graphStatus(m, filterRef.current));
    // Re-render around the survivor; this also selects it and syncs ?node=.
    const loaded = await loadNeighborhood(result.survivorId);
    if (!loaded.ok && !loaded.aborted) {
      // The merge committed even if the reload failed — still show the survivor.
      setSelectedNode(result.node);
      syncUrl(searchRef.current, result.survivorId);
    }
  }

  // The apply request may or may not have committed (network or gateway
  // error). Refresh the list and the canvas so the user can see which: if it
  // did, the reload follows the absorbed node's redirect to the survivor.
  function handleMergeOutcomeUnknown() {
    void loadSidebarNodes(searchRef.current);
    const focusId = selectedNode?.id ?? mergeFrom?.id;
    if (focusId) void loadNeighborhood(focusId);
  }

  // ── Drawer close ───────────────────────────────────────────────────────────

  function handleDrawerClose() {
    // xyflow re-measures the wider canvas itself.
    setSelectedNode(null);
    syncUrl(search, undefined);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="kg" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Knowledge Graph">
            <TopbarSearch
              placeholder="Search nodes…"
              value={search}
              onChange={v => handleSearch(v)}
              onSubmit={submitSearch}
            />
            <TopbarDivider />
          </Topbar>

          {/* Mobile search bar (TopbarSearch hidden at ≤768px) */}
          <div className="kg-mobile-search">
            <input
              type="text"
              placeholder="Search nodes…"
              value={search}
              onChange={e => handleSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitSearch(); }}
            />
          </div>

          <div className="kg-layout">
              {/* Left: node list sidebar */}
              <div className="kg-sidebar">
                <div className="kg-sidebar-search">
                  <input
                    type="text"
                    placeholder="Search…"
                    value={search}
                    onChange={e => handleSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitSearch(); }}
                    aria-label="Search knowledge graph nodes"
                  />
                  <button onClick={submitSearch}>Search</button>
                </div>
                <details className="kg-filters" open>
                  <summary>
                    Filters{filterActive ? ` (${filter.types.size + filter.sensitivities.size})` : ''}
                    {filterActive && (
                      <button
                        className="kg-filters-clear"
                        onClick={e => { e.preventDefault(); updateFilter(emptyFilter()); }}
                      >
                        Clear filters
                      </button>
                    )}
                  </summary>
                  {renderFilterAxis('types', 'Type', options.types)}
                  {renderFilterAxis('sensitivities', 'Sensitivity', options.sensitivities)}
                </details>
                <div className="kg-sidebar-list">
                  {sidebarLoading && (
                    <div className="kg-loader-inline" role="status">
                      <AnimatedMoonrayMark size={18} aria-hidden="true" role="presentation" />
                      <span>Searching</span>
                    </div>
                  )}
                  {loadError ? (
                    <p style={{ fontSize: 12, color: 'var(--app-destructive)', margin: 0 }}>
                      {loadError}
                    </p>
                  ) : visibleSidebarNodes.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--app-fg-muted)', margin: 0 }}>
                      {sidebarNodes.length > 0 ? 'No nodes match the active filters.' : 'No matching nodes.'}
                    </p>
                  ) : (
                    visibleSidebarNodes.map(node => (
                      <button
                        key={node.id}
                        className="kg-node-card"
                        onClick={() => { setBanner(null); void loadNeighborhood(node.id); }}
                        title={`Load ${node.label}'s neighborhood`}
                      >
                        <div className="kg-node-card-label">{node.label}</div>
                        <div className="kg-node-card-meta">
                          {node.type} · {node.confidence != null ? node.confidence.toFixed(2) : '—'}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              {/* Center: canvas + toolbar */}
              <div className="kg-canvas-wrap">
                <div className="kg-toolbar">
                  <span className="kg-toolbar-label">Color by</span>
                  <button
                    className={`kg-color-btn${colorMode === 'type' ? ' active' : ''}`}
                    onClick={() => handleColorMode('type')}
                    aria-pressed={colorMode === 'type'}
                  >
                    Type
                  </button>
                  <button
                    className={`kg-color-btn${colorMode === 'sensitivity' ? ' active' : ''}`}
                    onClick={() => handleColorMode('sensitivity')}
                    aria-pressed={colorMode === 'sensitivity'}
                  >
                    Sensitivity
                  </button>
                  <button
                    className={`kg-color-btn${colorMode === 'decay' ? ' active' : ''}`}
                    onClick={() => handleColorMode('decay')}
                    aria-pressed={colorMode === 'decay'}
                  >
                    Decay
                  </button>
                  {status && <span className="kg-status">{status}</span>}
                </div>
                {banner && (
                  <div className={`kg-merge-banner${banner.notes?.length ? ' is-warn' : ''}`} role="status">
                    <div className="kg-merge-banner-body">
                      <span>{banner.text}</span>
                      {banner.notes && banner.notes.length > 0 && (
                        <ul className="kg-merge-banner-notes">
                          {banner.notes.map(n => <li key={n}>{n}</li>)}
                        </ul>
                      )}
                    </div>
                    <button
                      className="kg-merge-banner-close"
                      onClick={() => setBanner(null)}
                      aria-label="Dismiss"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}
                <div className="kg-canvas" ref={canvasRef}>
                  <ReactFlow<KgFlowNode, KgFlowEdge>
                    nodes={rfNodes}
                    edges={rfEdges}
                    nodeTypes={KG_NODE_TYPES}
                    edgeTypes={KG_EDGE_TYPES}
                    onNodesChange={onNodesChange}
                    onNodeClick={onNodeClick}
                    onNodeDoubleClick={onNodeDoubleClick}
                    onNodeDragStop={onNodeDragStop}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    edgesFocusable={false}
                    deleteKeyCode={null}
                    zoomOnDoubleClick={false}
                    minZoom={0.05}
                    maxZoom={4}
                  >
                    <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--kg-grid)" />
                    <Controls
                      position="bottom-left"
                      showInteractive={false}
                      fitViewOptions={{ padding: 0.15, duration: 300, maxZoom: FIT_MAX_ZOOM }}
                    />
                    <ZoomLevelClass target={canvasRef} />
                  </ReactFlow>
                  {busy && (
                    <div key={busy.seq} className={`kg-loader kg-loader--${busy.kind}`} role="status" aria-live="polite">
                      <AnimatedMoonrayMark size={busy.kind === 'load' ? 64 : 22} aria-hidden="true" role="presentation" />
                      <span className="kg-loader-label">{busy.kind === 'load' ? 'Loading graph' : 'Expanding'}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Right: node detail drawer (conditional) */}
              {selectedNode && (
                <NodeDetailDrawer
                  key={selectedNode.id}
                  node={selectedNode}
                  onClose={handleDrawerClose}
                  onMerge={() => setMergeFrom(selectedNode)}
                />
              )}
              {mergeFrom && (
                <MergeNodesDialog
                  key={mergeFrom.id}
                  node={mergeFrom}
                  onClose={() => setMergeFrom(null)}
                  onMerged={(result, labels) => void handleMerged(result, labels)}
                  onOutcomeUnknown={handleMergeOutcomeUnknown}
                />
              )}
            </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
