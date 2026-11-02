import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { booksBatchRoutes } from '../../../../../src/channels/http/routes/books-batches.js';
import { BatchError, type BatchStore } from '../../../../../src/books/batch-store.js';
import type { BooksToken } from '../../../../../src/quickbooks/books-token.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const TOKEN = 'books-secret';
const auth = { authorization: `Bearer ${TOKEN}` };
const session = { cookie: 'curia_session=sess' };
const ID = 'abcdef0123456789';
const row = (id: string) => ({ id, amount: '-5.00', date: '2026-11-02', description: 'COFFEE' });

function fakeStore(overrides: Partial<Record<keyof BatchStore, unknown>> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string, result: unknown) => async (...args: unknown[]) => { calls.push([name, args]); return result; };
  const store = {
    upsertBatch: rec('upsertBatch', 1),
    approvedForPosting: rec('approvedForPosting', [{ batch_id: ID, rows: [row('r1')] }]),
    recordResults: rec('recordResults', { recorded: 1, ignored: [] }),
    listBatches: rec('listBatches', [{ batch_id: ID }]),
    getBatch: rec('getBatch', { batch_id: ID, rows: [] }),
    editRow: rec('editRow', { id: 'r1' }),
    decide: rec('decide', 2),
    ...overrides,
  } as unknown as BatchStore;
  return { store, calls };
}

describe('books batch routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(store: BatchStore, token: string | null = TOKEN) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    const booksToken = { verify: async (p: string) => (token === null ? null : p === token) } as unknown as BooksToken;
    await app.register(booksBatchRoutes, { logger: createSilentLogger(), batchStore: store, booksToken, webAppBootstrapSecret: 'boot', sessions });
  }

  describe('books token routes', () => {
    it('are 404 with no token configured, 401 without or with a wrong one', async () => {
      await build(fakeStore().store, null);
      expect((await app.inject({ method: 'GET', url: '/books/batches/approved', headers: auth })).statusCode).toBe(404);
      await app.close();
      await build(fakeStore().store);
      const payload = { batch: { batch_id: ID, rows: [row('r1')] }, report: {} };
      for (const [method, url] of [['GET', '/books/batches/approved'], ['POST', '/books/batches'], ['POST', `/books/batches/${ID}/results`]] as const) {
        expect((await app.inject({ method, url, payload })).statusCode, `${method} ${url}`).toBe(401);
        expect((await app.inject({ method, url, payload, headers: { authorization: 'Bearer no' } })).statusCode).toBe(401);
      }
      expect((await app.inject({ method: 'GET', url: '/books/batches/approved', headers: auth })).statusCode).toBe(200);
    });

    it('a session cookie does not open them', async () => {
      await build(fakeStore().store);
      expect((await app.inject({ method: 'GET', url: '/books/batches/approved', headers: session })).statusCode).toBe(401);
    });

    it('stores a pushed batch', async () => {
      const { store, calls } = fakeStore();
      await build(store);
      const res = await app.inject({ method: 'POST', url: '/books/batches', headers: auth, payload: { batch: { batch_id: ID, revision: 0, rows: [row('r1')] }, report: { status: 'ready' } } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, rows: 1 });
      expect(calls[0]).toEqual(['upsertBatch', [ID, { status: 'ready' }, [row('r1')]]]);
    });

    it('rejects a bad push before storing anything', async () => {
      const { store, calls } = fakeStore();
      await build(store);
      for (const batch of [{ batch_id: 'nothex!', rows: [] }, { batch_id: ID, rows: 'x' }, { batch_id: ID, rows: [{ id: 'r' }] }, undefined]) {
        const res = await app.inject({ method: 'POST', url: '/books/batches', headers: auth, payload: { batch, report: {} } });
        expect(res.statusCode).toBe(400);
      }
      expect(calls).toHaveLength(0);
    });

    it('lists approved rows and records results', async () => {
      const { store, calls } = fakeStore();
      await build(store);
      const approved = await app.inject({ method: 'GET', url: '/books/batches/approved', headers: auth });
      expect(approved.json().batches[0].rows[0].id).toBe('r1');
      expect(approved.headers['cache-control']).toBe('no-store');
      const results = { r1: { status: 'posted', qbo_id: '77' } };
      const res = await app.inject({ method: 'POST', url: `/books/batches/${ID}/results`, headers: auth, payload: { results } });
      expect(res.json()).toEqual({ ok: true, recorded: 1, ignored: [] });
      expect(calls[1]).toEqual(['recordResults', [ID, results]]);
      expect((await app.inject({ method: 'POST', url: '/books/batches/not-a-batch/results', headers: auth, payload: { results } })).statusCode).toBe(400);
    });

    it('maps store errors to 400, 404 and 409', async () => {
      await build(fakeStore({ recordResults: async () => { throw new BatchError('No such batch', 'not_found'); } }).store);
      expect((await app.inject({ method: 'POST', url: `/books/batches/${ID}/results`, headers: auth, payload: { results: {} } })).statusCode).toBe(404);
      await app.close();
      await build(fakeStore({ recordResults: async () => { throw new Error('db down'); } }).store);
      const res = await app.inject({ method: 'POST', url: `/books/batches/${ID}/results`, headers: auth, payload: { results: {} } });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('db down');
    });
  });

  describe('owner routes', () => {
    it('need a signed-in session, and the books token does not open them', async () => {
      await build(fakeStore().store);
      const cases = [
        ['GET', '/api/books/batches', undefined],
        ['GET', `/api/books/batches/${ID}`, undefined],
        ['PATCH', `/api/books/batches/${ID}/rows/r1`, { edits: { category: 'A' } }],
        ['POST', `/api/books/batches/${ID}/decide`, { row_ids: ['r1'], decision: 'approved' }],
      ] as const;
      for (const [method, url, payload] of cases) {
        expect((await app.inject({ method, url, payload })).statusCode, `${method} ${url}`).toBe(401);
        expect((await app.inject({ method, url, payload, headers: auth })).statusCode).toBe(401);
        expect((await app.inject({ method, url, payload, headers: session })).statusCode).toBe(200);
      }
    });

    it('edits a row and decides rows', async () => {
      const { store, calls } = fakeStore();
      await build(store);
      const edit = await app.inject({ method: 'PATCH', url: `/api/books/batches/${ID}/rows/r1`, headers: session, payload: { edits: { category: 'Bank charges' } } });
      expect(edit.json()).toEqual({ row: { id: 'r1' } });
      expect(calls[0]).toEqual(['editRow', [ID, 'r1', { category: 'Bank charges' }]]);
      const dec = await app.inject({ method: 'POST', url: `/api/books/batches/${ID}/decide`, headers: session, payload: { row_ids: ['r1', 'r2'], decision: 'approved' } });
      expect(dec.json()).toEqual({ ok: true, updated: 2 });
      expect(calls[1]).toEqual(['decide', [ID, ['r1', 'r2'], 'approved']]);
    });

    it('validates the decision request before calling the store', async () => {
      const { store, calls } = fakeStore();
      await build(store);
      const post = (payload: unknown) => app.inject({ method: 'POST', url: `/api/books/batches/${ID}/decide`, headers: session, payload: payload as Record<string, unknown> });
      expect((await post({ row_ids: 'r1', decision: 'approved' })).statusCode).toBe(400);
      expect((await post({ row_ids: [1], decision: 'approved' })).statusCode).toBe(400);
      expect((await post({ row_ids: ['r1'], decision: 'posted' })).statusCode).toBe(400);
      expect((await post({})).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/books/batches/zzz', headers: session })).statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('shows the store\'s message when a row cannot be approved or edited', async () => {
      await build(fakeStore({
        decide: async () => { throw new BatchError('Row r1 has an unresolved flag (needs_category) and no category: choose a category first'); },
        editRow: async () => { throw new BatchError('That row is already posted to QuickBooks', 'locked'); },
      }).store);
      const dec = await app.inject({ method: 'POST', url: `/api/books/batches/${ID}/decide`, headers: session, payload: { row_ids: ['r1'], decision: 'approved' } });
      expect(dec.statusCode).toBe(400);
      expect(dec.json().error).toContain('choose a category');
      const edit = await app.inject({ method: 'PATCH', url: `/api/books/batches/${ID}/rows/r1`, headers: session, payload: { edits: { category: 'A' } } });
      expect(edit.statusCode).toBe(409);
    });
  });
});
