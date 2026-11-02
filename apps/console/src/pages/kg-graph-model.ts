// The Knowledge Graph canvas's data (ADR-058): the nodes and edges on the canvas, their
// positions, and the conversion to xyflow nodes and edges. Kept free of React so it can be
// unit-tested; KgPage owns one model and rebuilds the xyflow arrays from it.

import { MarkerType } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { matchesFilter, normalizeSensitivity } from './kg-filters.js';
import type { KgFilter, KgFilterable } from './kg-filters.js';
import type { ApiKgNode } from './kg-types.js';
import type { LayoutRequest } from './kg-layout.js';

export interface ApiKgEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  confidence: number;
}

export type ColorMode = 'type' | 'sensitivity' | 'decay' | 'accounting';

export interface Point { x: number; y: number }

/** What is on the canvas. `pos` holds node centres; a node without one is not drawn yet. */
export interface GraphModel {
  nodes: Map<string, ApiKgNode>;
  edges: Map<string, ApiKgEdge>;
  pos: Map<string, Point>;
}

export type KgNodeData = {
  label: string;
  size: number;
  colorClass: string;
  opacity: number;
  isFact: boolean;
  focal: boolean;
};

export type KgEdgeData = {
  label: string;
  /** Touches the focal node: drawn in the accent colour. */
  focal: boolean;
  /**
   * Where along the line (0 = source, 1 = target) to put the relationship label, or null for
   * none. Only the focal node's edges are labelled, away from the focal end so labels around
   * a hub spread out; edges to fact dots are never labelled.
   */
  labelAt: number | null;
  /** Radii of the end nodes, so the line stops at each circle's edge and the arrow shows. */
  sourceR: number;
  targetR: number;
};

export type KgFlowNode = Node<KgNodeData, 'kg'>;
export type KgFlowEdge = Edge<KgEdgeData, 'kg'>;

// ── Model ─────────────────────────────────────────────────────────────────────

export function emptyModel(): GraphModel {
  return { nodes: new Map(), edges: new Map(), pos: new Map() };
}

export function modelFrom(payload: { nodes: ApiKgNode[]; edges: ApiKgEdge[] }): GraphModel {
  const m = emptyModel();
  addToModel(m, payload);
  return m;
}

/** Adds what is not already on the canvas. Returns how many nodes and edges were new. */
export function addToModel(m: GraphModel, payload: { nodes: ApiKgNode[]; edges: ApiKgEdge[] }): { nodes: number; edges: number } {
  let nodes = 0, edges = 0;
  for (const n of payload.nodes) if (!m.nodes.has(n.id)) { m.nodes.set(n.id, n); nodes++; }
  for (const e of payload.edges) if (!m.edges.has(e.id)) { m.edges.set(e.id, e); edges++; }
  return { nodes, edges };
}

/** Removes a node, its position and every edge touching it. */
export function removeNode(m: GraphModel, id: string): void {
  m.nodes.delete(id);
  m.pos.delete(id);
  for (const [eid, e] of m.edges) if (e.sourceNodeId === id || e.targetNodeId === id) m.edges.delete(eid);
}

/** Edges whose two ends are both on the canvas. */
export function liveEdges(m: GraphModel): ApiKgEdge[] {
  return [...m.edges.values()].filter(e => m.nodes.has(e.sourceNodeId) && m.nodes.has(e.targetNodeId));
}

export function degrees(m: GraphModel): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of liveEdges(m)) {
    d.set(e.sourceNodeId, (d.get(e.sourceNodeId) ?? 0) + 1);
    d.set(e.targetNodeId, (d.get(e.targetNodeId) ?? 0) + 1);
  }
  return d;
}

/** The node and its direct neighbours. */
export function closedNeighborhood(m: GraphModel, id: string): string[] {
  const ids = new Set([id]);
  for (const e of liveEdges(m)) {
    if (e.sourceNodeId === id) ids.add(e.targetNodeId);
    if (e.targetNodeId === id) ids.add(e.sourceNodeId);
  }
  return [...ids].filter(i => m.nodes.has(i));
}

/** The node as the drawer and merge dialog expect it: defaults filled in, sensitivity normalised. */
export function drawerNode(n: ApiKgNode): ApiKgNode {
  return {
    ...n,
    confidence: n.confidence ?? 0.5,
    decayClass: n.decayClass || 'permanent',
    sensitivity: normalizeSensitivity(n.sensitivity),
    properties: n.properties ?? {},
    source: n.source ?? '',
    createdAt: n.createdAt ?? '',
    lastConfirmedAt: n.lastConfirmedAt ?? '',
  };
}

export function nodeVisible(n: ApiKgNode, filter: KgFilter): boolean {
  return matchesFilter({ type: n.type, sensitivity: normalizeSensitivity(n.sensitivity) }, filter);
}

/** type/sensitivity of every node on the canvas, for the filter checklists. */
export function facets(m: GraphModel): KgFilterable[] {
  return [...m.nodes.values()].map(n => ({ type: n.type, sensitivity: normalizeSensitivity(n.sensitivity) }));
}

export function graphStatus(m: GraphModel, filter: KgFilter): string {
  let hidden = 0;
  for (const n of m.nodes.values()) if (!nodeVisible(n, filter)) hidden++;
  const base = `${m.nodes.size} nodes · ${liveEdges(m).length} edges`;
  return hidden > 0 ? `${base} · ${hidden} hidden by filters` : base;
}

// ── Appearance ────────────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Hubs stand out: 14px with no edges up to 56px at 15 or more. Facts are fixed small dots. */
export function nodeSize(type: string, degree: number): number {
  if (type === 'fact') return 8;
  return 14 + (Math.min(Math.max(degree, 0), 15) / 15) * 42;
}

const KNOWN_TYPES = new Set(['person', 'organization', 'project', 'decision', 'event', 'concept', 'fact']);
const KNOWN_SENS = new Set(['public', 'internal', 'confidential', 'restricted']);
const KNOWN_DECAY = new Set(['permanent', 'slow_decay', 'fast_decay']);

const ACCOUNTING_TYPES = new Set(['category', 'bank_account', 'tax_code', 'location', 'class', 'payee']);
const RULE_KINDS = new Set(['category', 'tax', 'vendor', 'location', 'class']);

/**
 * Classes for a node of the accounting rules graph: fill by what it is (rules by what they assign), rules drawn
 * as rounded squares, and the rule's status (proposed: dashed outline; retired or dismissed: struck-through label).
 */
export function accountingClass(n: ApiKgNode): string {
  if (n.type !== 'rule') return `kg-c-acct-${ACCOUNTING_TYPES.has(n.type) ? n.type : 'other'}`;
  const props = n.properties ?? {};
  const kind = typeof props['ruleKind'] === 'string' && RULE_KINDS.has(props['ruleKind']) ? props['ruleKind'] : 'other';
  const status = props['status'];
  const cls = [`kg-c-acct-rule-${kind}`, 'kg-shape-rule'];
  if (status === 'proposed') cls.push('kg-st-proposed');
  if (status === 'retired' || status === 'dismissed') cls.push('kg-st-retired');
  return cls.join(' ');
}

/** Swatch class for a type in the accounting filter list. */
export function accountingSwatchClass(type: string): string {
  return `kg-c-acct-${ACCOUNTING_TYPES.has(type) ? type : type === 'rule' ? 'rule-other' : 'other'}`;
}

/** CSS class carrying the node's fill (colours live in app.css, so they follow the theme). */
export function colorClass(n: ApiKgNode, mode: ColorMode): string {
  if (mode === 'accounting') return accountingClass(n);
  if (mode === 'sensitivity') {
    const s = normalizeSensitivity(n.sensitivity);
    return `kg-c-sens-${KNOWN_SENS.has(s) ? s : 'other'}`;
  }
  if (mode === 'decay') {
    const d = n.decayClass || 'permanent';
    return `kg-c-decay-${KNOWN_DECAY.has(d) ? d : 'other'}`;
  }
  return `kg-c-type-${KNOWN_TYPES.has(n.type) ? n.type : 'other'}`;
}

/** Colour class for a filter option or list card, matching how the canvas colours that value. */
export function swatchClass(axis: 'types' | 'sensitivities', value: string): string {
  if (axis === 'sensitivities') return `kg-c-sens-${KNOWN_SENS.has(value) ? value : 'other'}`;
  return `kg-c-type-${KNOWN_TYPES.has(value) ? value : 'other'}`;
}

// Two shared arrowhead definitions (quiet and focal); colours follow the theme.
const ARROW = { type: MarkerType.ArrowClosed, color: 'var(--kg-edge)', width: 8, height: 8 };
const ARROW_FOCAL = { type: MarkerType.ArrowClosed, color: 'var(--kg-edge-focal)', width: 8, height: 8 };

export interface FlowOptions {
  colorMode: ColorMode;
  filter: KgFilter;
  focalId: string | null;
  selectedId: string | null;
}

/** Previous xyflow objects, reused when nothing about them changed so memoised nodes skip re-rendering. */
export interface FlowCache {
  nodes: Map<string, { key: string; node: KgFlowNode }>;
  edges: Map<string, { key: string; edge: KgFlowEdge }>;
}

export function emptyFlowCache(): FlowCache {
  return { nodes: new Map(), edges: new Map() };
}

/**
 * xyflow nodes and edges for everything on the canvas that has a position. Filtered-out
 * nodes, and every edge touching one, are `hidden` (they stay in the model and the counts).
 */
export function buildFlow(m: GraphModel, opts: FlowOptions, cache: FlowCache): { nodes: KgFlowNode[]; edges: KgFlowEdge[] } {
  const deg = degrees(m);
  const sizes = new Map<string, number>();
  const hiddenIds = new Set<string>();
  const nodes: KgFlowNode[] = [];
  const nextNodeCache: FlowCache['nodes'] = new Map();

  for (const n of m.nodes.values()) {
    const size = nodeSize(n.type, deg.get(n.id) ?? 0);
    sizes.set(n.id, size);
    const visible = nodeVisible(n, opts.filter);
    if (!visible) hiddenIds.add(n.id);
    const p = m.pos.get(n.id);
    if (!p) continue;

    const data: KgNodeData = {
      label: n.label,
      size,
      colorClass: colorClass(n, opts.colorMode),
      opacity: 0.15 + clamp01(n.confidence ?? 0.5) * 0.85,
      isFact: n.type === 'fact',
      focal: n.id === opts.focalId,
    };
    const x = p.x - size / 2, y = p.y - size / 2;
    const selected = n.id === opts.selectedId;
    const key = [x, y, !visible, selected, data.label, size, data.colorClass, data.opacity, data.focal].join('|');
    const prev = cache.nodes.get(n.id);
    const node: KgFlowNode = prev && prev.key === key ? prev.node : {
      id: n.id, type: 'kg', position: { x, y }, width: size, height: size,
      hidden: !visible, selected, data,
    };
    nextNodeCache.set(n.id, { key, node });
    nodes.push(node);
  }

  const edges: KgFlowEdge[] = [];
  const nextEdgeCache: FlowCache['edges'] = new Map();
  for (const e of liveEdges(m)) {
    if (!m.pos.has(e.sourceNodeId) || !m.pos.has(e.targetNodeId)) continue;
    const conf = clamp01(e.confidence ?? 0.5);
    const hidden = hiddenIds.has(e.sourceNodeId) || hiddenIds.has(e.targetNodeId);
    const sourceR = (sizes.get(e.sourceNodeId) ?? 0) / 2;
    const targetR = (sizes.get(e.targetNodeId) ?? 0) / 2;
    const focal = opts.focalId !== null && (e.sourceNodeId === opts.focalId || e.targetNodeId === opts.focalId);
    const toFact = m.nodes.get(e.sourceNodeId)?.type === 'fact' || m.nodes.get(e.targetNodeId)?.type === 'fact';
    const labelAt = focal && !toFact ? (e.sourceNodeId === opts.focalId ? 0.6 : 0.4) : null;
    const key = [hidden, e.type, conf, sourceR, targetR, focal, labelAt].join('|');
    const prev = cache.edges.get(e.id);
    const edge: KgFlowEdge = prev && prev.key === key ? prev.edge : {
      id: e.id, type: 'kg', source: e.sourceNodeId, target: e.targetNodeId, hidden,
      markerEnd: focal ? ARROW_FOCAL : ARROW,
      // Width and strength by confidence; the focal node's edges stand forward.
      style: { strokeWidth: 0.75 + conf * 1.75, opacity: focal ? 0.55 + conf * 0.4 : 0.12 + conf * 0.45 },
      ...(focal ? { className: 'is-focal-edge' } : {}),
      data: { label: e.type, sourceR, targetR, focal, labelAt },
    };
    nextEdgeCache.set(e.id, { key, edge });
    edges.push(edge);
  }

  cache.nodes = nextNodeCache;
  cache.edges = nextEdgeCache;
  return { nodes, edges };
}

// ── Layout plumbing ───────────────────────────────────────────────────────────

export function layoutRequest(m: GraphModel, seq: number, mode: 'full' | 'expand', anchorId?: string): LayoutRequest {
  const deg = degrees(m);
  return {
    seq,
    mode,
    ...(anchorId ? { anchorId } : {}),
    nodes: [...m.nodes.values()].map(n => {
      const p = mode === 'expand' ? m.pos.get(n.id) : undefined;
      return {
        id: n.id,
        type: n.type,
        decayClass: n.decayClass || 'permanent',
        size: nodeSize(n.type, deg.get(n.id) ?? 0),
        ...(p ? { x: p.x, y: p.y } : {}),
      };
    }),
    edges: liveEdges(m).map(e => ({
      source: e.sourceNodeId, target: e.targetNodeId, label: e.type, confidence: e.confidence ?? 0.5,
    })),
  };
}

/** Stores layout results for nodes still on the canvas (one may have been removed meanwhile). */
export function applyPositions(m: GraphModel, positions: Record<string, Point>): void {
  for (const [id, p] of Object.entries(positions)) if (m.nodes.has(id)) m.pos.set(id, p);
}
