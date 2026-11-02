import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { booksGraphRoutes } from '../../../../../src/channels/http/routes/books-graph.js';
import type { GraphSnapshot, GraphSnapshotStore } from '../../../../../src/books/graph-store.js';
import type { BooksToken } from '../../../../../src/quickbooks/books-token.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const TOKEN = 'books-secret';
const auth = { authorization: `Bearer ${TOKEN}` };
const session = { cookie: 'curia_session=sess' };
const snapshot = {
  version: 1,
  generated_at: '2026-11-02T12:00:00Z',
  nodes: [{ id: 'a', type: 'rule', label: 'A' }, { id: 'b', type: 'category', label: 'B' }],
  edges: [{ id: 'e1', sourceNodeId: 'a', targetNodeId: 'b', type: 'assigns' }],
};

describe('books graph routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  function fakeStore(initial: { snapshot: GraphSnapshot; received_at: string } | null = null, fail = false) {
    let stored = initial;
    const store = {
      replace: async (s: GraphSnapshot) => {
        if (fail) throw new Error('db down');
        stored = { snapshot: s, received_at: '2026-11-02T12:00:00.000Z' };
      },
      latest: async () => {
        if (fail) throw new Error('db down');
        return stored;
      },
    } as unknown as GraphSnapshotStore;
    return { store, get: () => stored };
  }

  async function build(store: GraphSnapshotStore, token: string | null = TOKEN) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    const booksToken = { verify: async (p: string) => (token === null ? null : p === token) } as unknown as BooksToken;
    await app.register(booksGraphRoutes, { logger: createSilentLogger(), graphStore: store, booksToken, webAppBootstrapSecret: 'boot', sessions });
  }

  const post = (payload: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: '/books/graph', headers, payload: payload as Record<string, unknown> });

  it('POST needs the books token: 404 if none exists, 401 without or with a wrong one, and a session cookie does not open it', async () => {
    await build(fakeStore().store, null);
    expect((await post({ snapshot })).statusCode).toBe(404);
    await app.close();
    const { store, get } = fakeStore();
    await build(store);
    expect((await post({ snapshot }, {})).statusCode).toBe(401);
    expect((await post({ snapshot }, { authorization: 'Bearer no' })).statusCode).toBe(401);
    expect((await post({ snapshot }, session)).statusCode).toBe(401);
    expect(get()).toBeNull();
  });

  it('stores a valid snapshot and reports the counts', async () => {
    const { store, get } = fakeStore();
    await build(store);
    const res = await post({ snapshot });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, nodes: 2, edges: 1 });
    expect(get()?.snapshot.nodes).toHaveLength(2);
  });

  it('a new push replaces the old snapshot', async () => {
    const { store, get } = fakeStore();
    await build(store);
    await post({ snapshot });
    await post({ snapshot: { nodes: [{ id: 'z', type: 'rule', label: 'Z' }], edges: [] } });
    expect(get()?.snapshot.nodes.map(n => n.id)).toEqual(['z']);
  });

  it.each([
    ['no snapshot', {}],
    ['an unknown top-level key', { snapshot: { ...snapshot, transactions: [] } }],
    ['an edge to a node that is not there', { snapshot: { ...snapshot, edges: [{ id: 'e', sourceNodeId: 'a', targetNodeId: 'zz', type: 'x' }] } }],
    ['a node field that is not allowed', { snapshot: { ...snapshot, nodes: [{ id: 'a', type: 'rule', label: 'A', amount: '5' }] } }],
  ])('rejects %s with 400 and stores nothing', async (_label, body) => {
    const { store, get } = fakeStore();
    await build(store);
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
    expect(get()).toBeNull();
  });

  it('rejects a body over the size limit', async () => {
    await build(fakeStore().store);
    const big = { snapshot: { nodes: [{ id: 'a', type: 'rule', label: 'A', properties: { x: 'y'.repeat(2 * 1024 * 1024 + 8192) } }], edges: [] } };
    expect([400, 413]).toContain((await post(big)).statusCode);
  });

  it('answers 500 (no detail) when storing fails', async () => {
    await build(fakeStore(null, true).store);
    const res = await post({ snapshot });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('db down');
  });

  it('GET needs a signed-in person, and a books token does not open it', async () => {
    await build(fakeStore().store);
    expect((await app.inject({ method: 'GET', url: '/api/books/graph' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/books/graph', headers: auth })).statusCode).toBe(401);
  });

  it('GET says empty before anything arrives, then returns the snapshot and when it arrived', async () => {
    const { store } = fakeStore();
    await build(store);
    expect((await app.inject({ method: 'GET', url: '/api/books/graph', headers: session })).json()).toEqual({ empty: true });
    await post({ snapshot });
    const res = await app.inject({ method: 'GET', url: '/api/books/graph', headers: session });
    expect(res.statusCode).toBe(200);
    expect(res.json().received_at).toBe('2026-11-02T12:00:00.000Z');
    expect(res.json().snapshot.nodes).toHaveLength(2);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
