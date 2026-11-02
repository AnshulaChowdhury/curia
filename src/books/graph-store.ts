// graph-store.ts — the accounting rules graph snapshot the books Mac mini pushes for the Knowledge Graph page.
//
// The snapshot is untrusted JSON: it is validated strictly (known keys only, bounded sizes, edges that point at real
// nodes), stored as-is, returned as JSON, and only ever rendered as text. Only the latest snapshot is kept.

import type { DbPool } from '../db/connection.js';

export const MAX_NODES = 5000;
export const MAX_EDGES = 20000;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export class GraphError extends Error {}

export interface SnapshotNode {
  id: string;
  type: string;
  label: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  decayClass?: string;
  source?: string;
  createdAt?: string;
  lastConfirmedAt?: string;
  sensitivity?: string;
  aliases?: string[];
  archived?: boolean;
}

export interface SnapshotEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  confidence?: number;
  decayClass?: string;
  source?: string;
  createdAt?: string;
  lastConfirmedAt?: string;
}

export interface GraphSnapshot {
  version?: number;
  generated_at?: string;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
}

const TOP_KEYS = new Set(['version', 'generated_at', 'nodes', 'edges']);
const NODE_KEYS = new Set(['id', 'type', 'label', 'properties', 'confidence', 'decayClass', 'source', 'createdAt', 'lastConfirmedAt', 'sensitivity', 'aliases', 'archived']);
const EDGE_KEYS = new Set(['id', 'sourceNodeId', 'targetNodeId', 'type', 'confidence', 'decayClass', 'source', 'createdAt', 'lastConfirmedAt']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v: unknown, what: string, max: number, required = true): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || (required && v.length === 0) || v.length > max) {
    throw new GraphError(`${what} must be text of at most ${max} characters`);
  }
  return v;
}

function unit(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new GraphError(`${what} must be a number from 0 to 1`);
  return v;
}

function noUnknownKeys(o: Record<string, unknown>, allowed: Set<string>, what: string): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new GraphError(`${what} has an unexpected field "${k.slice(0, 40)}"`);
}

/** A property value: short text, a number, a boolean, null, or a short list of those. Nothing nested. */
function propertyValue(v: unknown, what: string): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new GraphError(`${what} must be a finite number`);
    return v;
  }
  if (typeof v === 'string') {
    if (v.length > 2000) throw new GraphError(`${what} is longer than 2000 characters`);
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length > 50) throw new GraphError(`${what} has more than 50 items`);
    return v.map((x, i) => {
      if (typeof x === 'object' && x !== null) throw new GraphError(`${what}[${i}] must be text, a number or a boolean`);
      return propertyValue(x, `${what}[${i}]`);
    });
  }
  throw new GraphError(`${what} must be text, a number, a boolean, null or a short list`);
}

function validateNode(raw: unknown, i: number): SnapshotNode {
  if (!isObject(raw)) throw new GraphError(`nodes[${i}] must be an object`);
  noUnknownKeys(raw, NODE_KEYS, `nodes[${i}]`);
  const node: SnapshotNode = {
    id: text(raw['id'], `nodes[${i}].id`, 300)!,
    type: text(raw['type'], `nodes[${i}].type`, 100)!,
    label: text(raw['label'], `nodes[${i}].label`, 300)!,
  };
  if (raw['properties'] !== undefined) {
    if (!isObject(raw['properties'])) throw new GraphError(`nodes[${i}].properties must be an object`);
    const keys = Object.keys(raw['properties']);
    if (keys.length > 50) throw new GraphError(`nodes[${i}].properties has more than 50 fields`);
    node.properties = {};
    for (const k of keys) {
      if (k.length > 100) throw new GraphError(`nodes[${i}].properties has a field name over 100 characters`);
      node.properties[k] = propertyValue(raw['properties'][k], `nodes[${i}].properties.${k.slice(0, 40)}`);
    }
  }
  const c = unit(raw['confidence'], `nodes[${i}].confidence`);
  if (c !== undefined) node.confidence = c;
  for (const k of ['decayClass', 'source', 'sensitivity'] as const) {
    const v = text(raw[k], `nodes[${i}].${k}`, 100, false);
    if (v !== undefined) node[k] = v;
  }
  for (const k of ['createdAt', 'lastConfirmedAt'] as const) {
    const v = text(raw[k], `nodes[${i}].${k}`, 40, false);
    if (v !== undefined) node[k] = v;
  }
  if (raw['aliases'] !== undefined) {
    if (!Array.isArray(raw['aliases']) || raw['aliases'].length > 20) throw new GraphError(`nodes[${i}].aliases must be a list of at most 20`);
    node.aliases = raw['aliases'].map((a, j) => text(a, `nodes[${i}].aliases[${j}]`, 300)!);
  }
  if (raw['archived'] !== undefined) {
    if (typeof raw['archived'] !== 'boolean') throw new GraphError(`nodes[${i}].archived must be true or false`);
    node.archived = raw['archived'];
  }
  return node;
}

function validateEdge(raw: unknown, i: number): SnapshotEdge {
  if (!isObject(raw)) throw new GraphError(`edges[${i}] must be an object`);
  noUnknownKeys(raw, EDGE_KEYS, `edges[${i}]`);
  const edge: SnapshotEdge = {
    id: text(raw['id'], `edges[${i}].id`, 700)!,
    sourceNodeId: text(raw['sourceNodeId'], `edges[${i}].sourceNodeId`, 300)!,
    targetNodeId: text(raw['targetNodeId'], `edges[${i}].targetNodeId`, 300)!,
    type: text(raw['type'], `edges[${i}].type`, 100)!,
  };
  const c = unit(raw['confidence'], `edges[${i}].confidence`);
  if (c !== undefined) edge.confidence = c;
  for (const k of ['decayClass', 'source'] as const) {
    const v = text(raw[k], `edges[${i}].${k}`, 100, false);
    if (v !== undefined) edge[k] = v;
  }
  for (const k of ['createdAt', 'lastConfirmedAt'] as const) {
    const v = text(raw[k], `edges[${i}].${k}`, 40, false);
    if (v !== undefined) edge[k] = v;
  }
  return edge;
}

/** Checks a pushed snapshot and returns a clean copy. Throws GraphError with a message the sender can act on. */
export function validateSnapshot(raw: unknown): GraphSnapshot {
  if (!isObject(raw)) throw new GraphError('snapshot must be an object');
  noUnknownKeys(raw, TOP_KEYS, 'snapshot');
  if (!Array.isArray(raw['nodes']) || !Array.isArray(raw['edges'])) throw new GraphError('snapshot needs a list of nodes and a list of edges');
  if (raw['nodes'].length > MAX_NODES) throw new GraphError(`at most ${MAX_NODES} nodes`);
  if (raw['edges'].length > MAX_EDGES) throw new GraphError(`at most ${MAX_EDGES} edges`);
  const out: GraphSnapshot = { nodes: [], edges: [] };
  if (raw['version'] !== undefined) {
    if (typeof raw['version'] !== 'number' || !Number.isInteger(raw['version'])) throw new GraphError('version must be a whole number');
    out.version = raw['version'];
  }
  const at = text(raw['generated_at'], 'generated_at', 40, false);
  if (at !== undefined) out.generated_at = at;

  const ids = new Set<string>();
  raw['nodes'].forEach((n, i) => {
    const node = validateNode(n, i);
    if (ids.has(node.id)) throw new GraphError(`node id "${node.id.slice(0, 80)}" appears twice`);
    ids.add(node.id);
    out.nodes.push(node);
  });
  const edgeIds = new Set<string>();
  raw['edges'].forEach((e, i) => {
    const edge = validateEdge(e, i);
    if (edgeIds.has(edge.id)) throw new GraphError(`edge id "${edge.id.slice(0, 80)}" appears twice`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId)) {
      throw new GraphError(`edges[${i}] points at a node that is not in the snapshot`);
    }
    out.edges.push(edge);
  });
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_SNAPSHOT_BYTES) throw new GraphError('snapshot is larger than 2 MB');
  return out;
}

export interface StoredSnapshot {
  snapshot: GraphSnapshot;
  received_at: string;
}

export class GraphSnapshotStore {
  constructor(private readonly pool: DbPool) {}

  /** Replaces whatever snapshot was stored. */
  async replace(snapshot: GraphSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO books_graph_snapshot (id, snapshot, received_at) VALUES (TRUE, $1, now())
       ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, received_at = EXCLUDED.received_at`,
      [JSON.stringify(snapshot)],
    );
  }

  async latest(): Promise<StoredSnapshot | null> {
    const res = await this.pool.query<{ snapshot: GraphSnapshot; received_at: Date }>(
      'SELECT snapshot, received_at FROM books_graph_snapshot WHERE id = TRUE',
    );
    const row = res.rows[0];
    return row ? { snapshot: row.snapshot, received_at: row.received_at.toISOString() } : null;
  }
}
