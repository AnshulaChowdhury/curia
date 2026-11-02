// Pure helpers for the accounting rules graph on the Knowledge Graph page (ADR-059): turning the pushed snapshot
// into the model the canvas draws, the text filter, and the plain-text rows of the detail panel. Free of React so
// it can be unit-tested. Everything in the snapshot is untrusted text; nothing here produces HTML.

import { emptyModel, liveEdges } from './kg-graph-model.js';
import type { ApiKgEdge, GraphModel } from './kg-graph-model.js';
import type { ApiKgNode } from './kg-types.js';

/** Mirrors GET /api/books/graph (src/channels/http/routes/books-graph.ts). */
export interface AccountingGraphResponse {
  empty?: boolean;
  snapshot?: { version?: number; generated_at?: string; nodes: Partial<ApiKgNode>[]; edges: Partial<ApiKgEdge>[] };
  received_at?: string;
}

export const TYPE_LABELS: Record<string, string> = {
  rule: 'Rule',
  category: 'Account',
  bank_account: 'Bank account',
  tax_code: 'Tax code',
  location: 'Location',
  class: 'Class',
  payee: 'Payee',
};

export const typeLabel = (type: string): string => TYPE_LABELS[type] ?? type;

/** Snapshot nodes carry only some of the memory-graph fields; fill the rest so the shared canvas code can use them. */
export function normaliseSnapshot(res: AccountingGraphResponse): { nodes: ApiKgNode[]; edges: ApiKgEdge[] } {
  const snap = res.snapshot;
  if (!snap) return { nodes: [], edges: [] };
  const nodes: ApiKgNode[] = snap.nodes.map(n => ({
    id: String(n.id),
    label: String(n.label ?? n.id),
    type: String(n.type ?? 'other'),
    confidence: typeof n.confidence === 'number' ? n.confidence : 1,
    decayClass: n.decayClass || 'permanent',
    sensitivity: n.sensitivity || 'internal',
    properties: n.properties ?? {},
    source: n.source ?? '',
    createdAt: n.createdAt ?? '',
    lastConfirmedAt: n.lastConfirmedAt ?? '',
    aliases: n.aliases ?? [],
    archived: n.archived ?? false,
  }));
  const edges: ApiKgEdge[] = snap.edges.map(e => ({
    id: String(e.id),
    sourceNodeId: String(e.sourceNodeId),
    targetNodeId: String(e.targetNodeId),
    type: String(e.type ?? ''),
    confidence: typeof e.confidence === 'number' ? e.confidence : 1,
  }));
  return { nodes, edges };
}

/** Does the node match the text? Looks at the label, id, type and every text property, ignoring case. */
export function matchesText(n: ApiKgNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) || typeLabel(n.type).toLowerCase().includes(q)) return true;
  return Object.values(n.properties ?? {}).some(v => typeof v === 'string' && v.toLowerCase().includes(q));
}

/** Nodes matching the text, plus their direct neighbours (so a match shows what it assigns). Null = no text, show all. */
export function visibleIds(m: GraphModel, query: string): Set<string> | null {
  if (!query.trim()) return null;
  const ids = new Set<string>();
  for (const n of m.nodes.values()) if (matchesText(n, query)) ids.add(n.id);
  const matched = new Set(ids);
  for (const e of liveEdges(m)) {
    if (matched.has(e.sourceNodeId)) ids.add(e.targetNodeId);
    if (matched.has(e.targetNodeId)) ids.add(e.sourceNodeId);
  }
  return ids;
}

/** The part of the model with the given nodes, keeping their positions so nothing jumps when the text changes. */
export function subModel(m: GraphModel, ids: Set<string>): GraphModel {
  const sub = emptyModel();
  for (const id of ids) {
    const n = m.nodes.get(id);
    if (!n) continue;
    sub.nodes.set(id, n);
    const p = m.pos.get(id);
    if (p) sub.pos.set(id, p);
  }
  for (const [id, e] of m.edges) if (ids.has(e.sourceNodeId) && ids.has(e.targetNodeId)) sub.edges.set(id, e);
  return sub;
}

/** How many nodes of each type, for the filter list. */
export function typeCounts(m: GraphModel): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of m.nodes.values()) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

const PROPERTY_LABELS: Record<string, string> = {
  ruleKind: 'Rule kind',
  status: 'Status',
  order: 'Order',
  pattern: 'Matches text',
  confirmedBy: 'Confirmed by',
  confirmedOn: 'Confirmed on',
  note: 'Note',
};
const PROPERTY_ORDER = Object.keys(PROPERTY_LABELS);

const asText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Label/value rows for the detail panel, as plain text. Known properties come first, in a fixed order. */
export function nodeRows(n: ApiKgNode): Array<{ label: string; value: string }> {
  const props = n.properties ?? {};
  const rows = [{ label: 'Kind', value: typeLabel(n.type) }, { label: 'Id', value: n.id }];
  const known = PROPERTY_ORDER.filter(k => props[k] !== undefined && props[k] !== null && asText(props[k]) !== '');
  const rest = Object.keys(props).filter(k => !PROPERTY_ORDER.includes(k) && asText(props[k]) !== '').sort();
  for (const k of [...known, ...rest]) rows.push({ label: PROPERTY_LABELS[k] ?? k, value: asText(props[k]) });
  return rows;
}

export interface Neighbour { id: string; label: string; type: string; relation: string; direction: 'out' | 'in' }

/** The node's direct connections, grouped by relation then label, for the panel. */
export function neighbours(m: GraphModel, id: string): Neighbour[] {
  const out: Neighbour[] = [];
  for (const e of liveEdges(m)) {
    const other = e.sourceNodeId === id ? e.targetNodeId : e.targetNodeId === id ? e.sourceNodeId : null;
    const n = other ? m.nodes.get(other) : undefined;
    if (!n) continue;
    out.push({ id: n.id, label: n.label, type: n.type, relation: e.type, direction: e.sourceNodeId === id ? 'out' : 'in' });
  }
  return out.sort((a, b) => a.relation.localeCompare(b.relation) || a.label.localeCompare(b.label));
}
