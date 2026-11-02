import { describe, it, expect } from 'vitest';
import { GraphError, GraphSnapshotStore, MAX_EDGES, MAX_NODES, validateSnapshot } from '../../../src/books/graph-store.js';
import type { DbPool } from '../../../src/db/connection.js';

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'rule', label: id, ...extra });
const edge = (id: string, s: string, t: string, extra: Record<string, unknown> = {}) => ({ id, sourceNodeId: s, targetNodeId: t, type: 'assigns', ...extra });
const snap = (over: Record<string, unknown> = {}) => ({ version: 1, generated_at: '2026-11-02T12:00:00Z', nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')], ...over });

describe('validateSnapshot', () => {
  it('accepts the exporter shape, with properties, confidence and aliases', () => {
    const out = validateSnapshot(snap({
      nodes: [node('rule:cat-1', { properties: { ruleKind: 'category', status: 'confirmed', order: 20, pattern: 'CANVA', flag: true, none: null, list: ['a', 1] }, confidence: 1, decayClass: 'permanent', source: 'books-rules', createdAt: '2026-11-01T00:00:00Z', lastConfirmedAt: '2026-11-02T12:00:00Z', sensitivity: 'internal', aliases: ['x'], archived: false }), node('b')],
      edges: [edge('e1', 'rule:cat-1', 'b', { confidence: 1 })],
    }));
    expect(out.nodes[0]).toMatchObject({ id: 'rule:cat-1', properties: { ruleKind: 'category', order: 20 }, confidence: 1 });
    expect(out.edges).toHaveLength(1);
  });

  it('accepts an empty graph', () => {
    expect(validateSnapshot({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });

  it.each([
    ['not an object', 'nope'],
    ['no nodes list', { edges: [] }],
    ['an unknown top-level key', snap({ transactions: [] })],
    ['an unknown node field', snap({ nodes: [node('a', { amount: '12.00' }), node('b')] })],
    ['an unknown edge field', snap({ edges: [edge('e1', 'a', 'b', { memo: 'x' })] })],
    ['a node without an id', snap({ nodes: [{ type: 'rule', label: 'x' }] })],
    ['an empty label', snap({ nodes: [node('a', { label: '' }), node('b')] })],
    ['a type over 100 characters', snap({ nodes: [node('a', { type: 'x'.repeat(101) }), node('b')] })],
    ['a numeric id', snap({ nodes: [{ id: 5, type: 'rule', label: 'x' }] })],
    ['a confidence above 1', snap({ nodes: [node('a', { confidence: 1.5 }), node('b')] })],
    ['a nested property', snap({ nodes: [node('a', { properties: { x: { y: 1 } } }), node('b')] })],
    ['a nested list item', snap({ nodes: [node('a', { properties: { x: [{ y: 1 }] } }), node('b')] })],
    ['a property over 2000 characters', snap({ nodes: [node('a', { properties: { x: 'z'.repeat(2001) } }), node('b')] })],
    ['duplicate node ids', snap({ nodes: [node('a'), node('a')], edges: [] })],
    ['duplicate edge ids', snap({ edges: [edge('e1', 'a', 'b'), edge('e1', 'b', 'a')] })],
    ['an edge to a node that is not there', snap({ edges: [edge('e1', 'a', 'zzz')] })],
    ['an edge from a node that is not there', snap({ edges: [edge('e1', 'zzz', 'a')] })],
    ['archived as text', snap({ nodes: [node('a', { archived: 'yes' }), node('b')] })],
    ['a version that is not a whole number', snap({ version: 1.5 })],
  ])('rejects %s', (_label, body) => {
    expect(() => validateSnapshot(body)).toThrow(GraphError);
  });

  it('limits the number of nodes and edges, and the total size', () => {
    const many = Array.from({ length: MAX_NODES + 1 }, (_, i) => node(`n${i}`));
    expect(() => validateSnapshot({ nodes: many, edges: [] })).toThrow(/at most 5000 nodes/);
    const edges = Array.from({ length: MAX_EDGES + 1 }, (_, i) => edge(`e${i}`, 'a', 'b'));
    expect(() => validateSnapshot({ nodes: [node('a'), node('b')], edges })).toThrow(/at most 20000 edges/);
    const fat = Array.from({ length: 1000 }, (_, i) => node(`n${i}`, { properties: { a: 'x'.repeat(2000), b: 'y'.repeat(2000) } }));
    expect(() => validateSnapshot({ nodes: fat, edges: [] })).toThrow(/2 MB/);
  });

  it('does not keep anything it was not told to keep', () => {
    const out = validateSnapshot(snap());
    expect(Object.keys(out).sort()).toEqual(['edges', 'generated_at', 'nodes', 'version']);
  });
});

describe('GraphSnapshotStore', () => {
  function fakePool() {
    let row: { snapshot: unknown; received_at: Date } | null = null;
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/^\s*INSERT/i.test(sql)) {
          row = { snapshot: JSON.parse(params[0] as string), received_at: new Date('2026-11-02T12:00:00Z') };
          return { rows: [] };
        }
        return { rows: row ? [row] : [] };
      },
    } as unknown as DbPool;
    return { pool, calls };
  }

  it('has nothing until a snapshot is stored, then returns the latest with when it arrived', async () => {
    const { pool } = fakePool();
    const store = new GraphSnapshotStore(pool);
    expect(await store.latest()).toBeNull();
    await store.replace(validateSnapshot(snap()));
    const got = await store.latest();
    expect(got?.received_at).toBe('2026-11-02T12:00:00.000Z');
    expect(got?.snapshot.nodes).toHaveLength(2);
  });

  it('replaces in place (one row) with a parameterised query', async () => {
    const { pool, calls } = fakePool();
    const store = new GraphSnapshotStore(pool);
    await store.replace(validateSnapshot(snap()));
    await store.replace(validateSnapshot(snap({ nodes: [node('c')], edges: [] })));
    const inserts = calls.filter(c => /INSERT/i.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
    expect(inserts[0]!.sql).not.toContain('"nodes"');
    expect((await store.latest())?.snapshot.nodes.map(n => n.id)).toEqual(['c']);
  });
});
