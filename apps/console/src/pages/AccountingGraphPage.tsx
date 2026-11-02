import { useState, useEffect, useRef, useCallback } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow } from '@xyflow/react';
import type { FitViewOptions, NodeChange, NodeMouseHandler, OnNodeDrag } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { AnimatedMoonrayMark } from '../components/Icons.js';
import { useTheme } from '../hooks/useTheme.js';
import { emptyFilter, isFilterActive, toggleFilterValue } from './kg-filters.js';
import type { KgFilter } from './kg-filters.js';
import {
  accountingSwatchClass, applyPositions, buildFlow, emptyFlowCache, emptyModel, graphStatus, layoutRequest, modelFrom,
} from './kg-graph-model.js';
import type { GraphModel, KgFlowEdge, KgFlowNode } from './kg-graph-model.js';
import { KG_EDGE_TYPES, KG_NODE_TYPES, ZoomLevelClass } from './kg-graph-view.js';
import { createLayoutClient } from './kg-layout-client.js';
import type { LayoutClient } from './kg-layout-client.js';
import { GraphSelector } from './GraphSelector.js';
import { neighbours, nodeRows, normaliseSnapshot, subModel, typeCounts, typeLabel, visibleIds } from './accounting-graph.js';
import type { AccountingGraphResponse } from './accounting-graph.js';

// The accounting rules graph: a read-only snapshot pushed by the books agent (ADR-059), drawn with the same
// xyflow components and d3-force layout as the memory graph (ADR-058).

const FIT_MAX_ZOOM = 1.25;

type Load = { state: 'loading' } | { state: 'empty' } | { state: 'error'; message: string } | { state: 'ready'; receivedAt: string; generatedAt: string };

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function AccountingGraphPage() {
  return (
    <ReactFlowProvider>
      <AccountingGraphInner />
    </ReactFlowProvider>
  );
}

function AccountingGraphInner() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { fitView } = useReactFlow<KgFlowNode, KgFlowEdge>();

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<GraphModel>(emptyModel());
  const flowCacheRef = useRef(emptyFlowCache());
  const layoutRef = useRef<LayoutClient | null>(null);
  const layoutSeqRef = useRef(0);
  const pendingFitRef = useRef<FitViewOptions<KgFlowNode> | null>(null);
  const [graphVersion, setGraphVersion] = useState(0);
  const [rfNodes, setRfNodes] = useState<KgFlowNode[]>([]);
  const [rfEdges, setRfEdges] = useState<KgFlowEdge[]>([]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<KgFilter>(emptyFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  // Fetch the snapshot, lay it out once, and draw it.
  useEffect(() => {
    const controller = new AbortController();
    const client = createLayoutClient();
    layoutRef.current = client;
    (async () => {
      try {
        const res = await apiFetch('/api/books/graph', { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as AccountingGraphResponse;
        if (body.empty || !body.snapshot) {
          setLoad({ state: 'empty' });
          return;
        }
        const model = modelFrom(normaliseSnapshot(body));
        modelRef.current = model;
        const seq = ++layoutSeqRef.current;
        const laid = await client.run(layoutRequest(model, seq, 'full'));
        if (controller.signal.aborted || seq !== layoutSeqRef.current) return;
        if (!laid.ok) throw new Error(`Layout failed: ${laid.error}`);
        applyPositions(model, laid.positions);
        pendingFitRef.current = { padding: 0.1, maxZoom: FIT_MAX_ZOOM };
        setLoad({ state: 'ready', receivedAt: body.received_at ?? '', generatedAt: body.snapshot.generated_at ?? '' });
        setGraphVersion(v => v + 1);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setLoad({ state: 'error', message: err instanceof Error ? err.message : 'Failed to load' });
      }
    })();
    return () => {
      controller.abort();
      client.dispose();
      layoutRef.current = null;
    };
  }, []);

  // Rebuild what xyflow draws: the text filter narrows the model (keeping positions), the type filter hides.
  useEffect(() => {
    const full = modelRef.current;
    const ids = visibleIds(full, text);
    const view = ids ? subModel(full, ids) : full;
    const { nodes, edges } = buildFlow(view, { colorMode: 'accounting', filter, focalId: selectedId, selectedId }, flowCacheRef.current);
    setRfNodes(nodes);
    setRfEdges(edges);
    setStatus(graphStatus(view, filter));
  }, [graphVersion, text, filter, selectedId]);

  // Fit the view after a new layout or a changed text filter.
  useEffect(() => {
    if (load.state === 'ready') pendingFitRef.current = { padding: 0.15, maxZoom: FIT_MAX_ZOOM };
  }, [text, load.state]);
  useEffect(() => {
    const fit = pendingFitRef.current;
    if (!fit) return;
    pendingFitRef.current = null;
    void fitView(fit);
  }, [rfNodes, fitView]);

  const onNodeClick: NodeMouseHandler<KgFlowNode> = (_e, node) => setSelectedId(node.id);
  const onNodesChange = useCallback((changes: NodeChange<KgFlowNode>[]) => {
    const relevant = changes.filter(c => c.type === 'position' || c.type === 'dimensions');
    if (relevant.length > 0) setRfNodes(ns => applyNodeChanges(relevant, ns));
  }, []);
  const onNodeDragStop: OnNodeDrag<KgFlowNode> = (_e, _node, dragged) => {
    for (const n of dragged) {
      modelRef.current.pos.set(n.id, { x: n.position.x + n.data.size / 2, y: n.position.y + n.data.size / 2 });
    }
  };

  const model = modelRef.current;
  const selected = selectedId ? model.nodes.get(selectedId) ?? null : null;
  const options = typeCounts(model);
  const filterActive = isFilterActive(filter);

  function selectNode(id: string) {
    setSelectedId(id);
    void fitView({ nodes: [{ id }], padding: '120px', duration: 300, maxZoom: FIT_MAX_ZOOM });
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="kg" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
        <main className="main">
          <Topbar crumb="Memory" title="Knowledge Graph">
            <GraphSelector current="accounting" />
            <TopbarDivider />
          </Topbar>

          {load.state === 'loading' && (
            <div className="kg-empty" role="status">
              <AnimatedMoonrayMark size={48} aria-hidden="true" role="presentation" /> Loading the accounting graph
            </div>
          )}
          {load.state === 'error' && <div className="kg-empty" style={{ color: 'var(--app-destructive)' }}>{load.message}</div>}
          {load.state === 'empty' && (
            <div className="kg-empty">
              <p style={{ margin: 0, fontWeight: 600, color: 'var(--app-fg)' }}>No accounting graph yet</p>
              <p style={{ margin: '6px 0 0' }}>The books run sends it: the rules, accounts, tax codes, locations, classes and payees (never transactions).</p>
            </div>
          )}

          {load.state === 'ready' && (
            <div className="kg-layout">
              <div className="kg-sidebar">
                <div className="kg-sidebar-search">
                  <input
                    type="text"
                    placeholder="Filter by text…"
                    value={text}
                    onChange={e => setText(e.target.value)}
                    aria-label="Filter the accounting graph by text"
                  />
                  {text && <button onClick={() => setText('')}>Clear</button>}
                </div>
                <details className="kg-filters" open>
                  <summary>
                    Type{filterActive ? ` (${filter.types.size})` : ''}
                    {filterActive && (
                      <button className="kg-filters-clear" onClick={e => { e.preventDefault(); setFilter(emptyFilter()); }}>Clear filters</button>
                    )}
                  </summary>
                  <fieldset className="kg-filter-axis">
                    <legend>Type</legend>
                    {options.map(opt => (
                      <label key={opt.value} className="kg-filter-option">
                        <input type="checkbox" checked={filter.types.has(opt.value)} onChange={() => setFilter(f => toggleFilterValue(f, 'types', opt.value))} />
                        <span className={`kg-swatch ${accountingSwatchClass(opt.value)}`} aria-hidden="true" />
                        <span className="kg-filter-option-name">{typeLabel(opt.value)}</span>
                        <span className="kg-filter-option-count">{opt.count}</span>
                      </label>
                    ))}
                  </fieldset>
                </details>
                <p className="kg-accounting-note">
                  Rules are rounded squares coloured by what they assign. A dashed outline is a proposed rule; a struck-through label is a retired one.
                </p>
                <p className="kg-accounting-note">
                  Snapshot made {fmtDate(load.generatedAt)}, received {fmtDate(load.receivedAt)}. Read-only; rules are changed in the rule files.
                </p>
                <div className="kg-sidebar-list">
                  {[...model.nodes.values()]
                    .filter(n => (!text.trim() || visibleIds(model, text)?.has(n.id)) && (filter.types.size === 0 || filter.types.has(n.type)))
                    .slice(0, 200)
                    .map(n => (
                      <button key={n.id} className="kg-node-card" onClick={() => selectNode(n.id)} title={`Show ${n.label}`}>
                        <div className="kg-node-card-label">{n.label}</div>
                        <div className="kg-node-card-meta">
                          <span className={`kg-swatch ${accountingSwatchClass(n.type)}`} aria-hidden="true" />
                          {typeLabel(n.type)}
                        </div>
                      </button>
                    ))}
                </div>
              </div>

              <div className="kg-canvas-wrap">
                <div className="kg-toolbar">{status && <span className="kg-status">{status}</span>}</div>
                <div className="kg-canvas" ref={canvasRef}>
                  <ReactFlow<KgFlowNode, KgFlowEdge>
                    nodes={rfNodes}
                    edges={rfEdges}
                    nodeTypes={KG_NODE_TYPES}
                    edgeTypes={KG_EDGE_TYPES}
                    onNodesChange={onNodesChange}
                    onNodeClick={onNodeClick}
                    onPaneClick={() => setSelectedId(null)}
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
                    <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: 0.15, duration: 300, maxZoom: FIT_MAX_ZOOM }} />
                    <ZoomLevelClass target={canvasRef} />
                  </ReactFlow>
                </div>
              </div>

              {selected && (
                <div className="kg-detail-drawer">
                  <div className="kg-detail-header">
                    <div className="kg-detail-header-top">
                      <div className="kg-detail-badges">
                        <span className="badge badge-kg-concept">{typeLabel(selected.type)}</span>
                      </div>
                      <button className="drawer-close" onClick={() => setSelectedId(null)} aria-label="Close">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="6" y1="6" x2="18" y2="18" />
                          <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                      </button>
                    </div>
                    <h2 className="kg-detail-title">{selected.label || '(no label)'}</h2>
                  </div>
                  <div className="kg-detail-body">
                    <div className="kg-detail-field">
                      <table className="kg-props-table">
                        <tbody>
                          {nodeRows(selected).map(r => (
                            <tr key={r.label}><td>{r.label}</td><td>{r.value}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {neighbours(model, selected.id).length > 0 && (
                      <div className="kg-detail-field">
                        <div className="kg-detail-field-label">Connected to</div>
                        <table className="kg-props-table">
                          <tbody>
                            {neighbours(model, selected.id).map(nb => (
                              <tr key={`${nb.relation}|${nb.direction}|${nb.id}`}>
                                <td>{nb.direction === 'out' ? nb.relation : `${nb.relation} (from)`}</td>
                                <td><button className="kg-node-card" style={{ padding: 0, border: 'none', background: 'none', textAlign: 'left' }} onClick={() => selectNode(nb.id)}>{nb.label}</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
