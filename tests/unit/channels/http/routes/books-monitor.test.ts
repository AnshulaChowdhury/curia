import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { booksMonitorRoutes } from '../../../../../src/channels/http/routes/books-monitor.js';
import type { MonitorStore, NewRun } from '../../../../../src/books/monitor-store.js';
import type { BooksMonitor } from '../../../../../src/books/monitor.js';
import { ReviewersError, type BooksNotifier } from '../../../../../src/books/notifier.js';
import type { BooksToken } from '../../../../../src/quickbooks/books-token.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const TOKEN = 'books-secret';
const auth = { authorization: `Bearer ${TOKEN}` };
const session = { cookie: 'curia_session=sess' };

function fakes(over: { monitorFails?: boolean } = {}) {
  const heartbeats: unknown[] = [];
  const runs: NewRun[] = [];
  const announced: NewRun[] = [];
  const store = {
    recordHeartbeat: async (h: unknown) => { heartbeats.push(h); },
    recordRun: async (r: NewRun) => { runs.push(r); },
  } as unknown as MonitorStore;
  const monitor = {
    onRunReported: async (r: NewRun) => { announced.push(r); if (over.monitorFails) throw new Error('ntfy down'); },
    status: async () => ({ heartbeat: null, lastRun: null, week: { missing: [] }, jobs: {}, lastNotifiedAt: null }),
  } as unknown as BooksMonitor;
  let saved: unknown = [{ name: 'A', email: 'a@x.com' }];
  const notifier = {
    getReviewers: async () => saved,
    setReviewers: async (v: unknown) => { if (!Array.isArray(v) || v.length > 2) throw new ReviewersError('too many'); saved = v; return v; },
  } as unknown as BooksNotifier;
  return { store, monitor, notifier, heartbeats, runs, announced };
}

describe('books monitor routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(f = fakes(), token: string | null = TOKEN) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    const booksToken = { verify: async (p: string) => (token === null ? null : p === token) } as unknown as BooksToken;
    await app.register(booksMonitorRoutes, { logger: createSilentLogger(), store: f.store, monitor: f.monitor, notifier: f.notifier, booksToken, webAppBootstrapSecret: 'boot', sessions });
    return f;
  }

  const hb = (payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url: '/books/heartbeat', headers, payload: payload as Record<string, unknown> });
  const runPost = (payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url: '/books/runs', headers, payload: payload as Record<string, unknown> });
  const good = { report: { status: 'ready', batch_id: 'abc12345' }, accounts_received: ['a1'], expected_accounts: ['a1', 'a2'], files: ['w.qbo'] };

  it('the machine routes need the books token (404 if none exists, 401 if wrong or missing)', async () => {
    await build();
    expect((await hb({}, {})).statusCode).toBe(401);
    expect((await hb({}, { authorization: 'Bearer no' })).statusCode).toBe(401);
    expect((await runPost(good, {})).statusCode).toBe(401);
    expect((await hb({})).statusCode).toBe(200);
    await app.close();
    await build(fakes(), null);
    expect((await hb({})).statusCode).toBe(404);
  });

  it('records a heartbeat and validates it', async () => {
    const f = await build();
    expect((await hb({ at: '2026-11-02T13:00:00Z', version: 'v1', state: 'idle', last_run_at: '2026-11-02T12:00:00Z' })).statusCode).toBe(200);
    expect(f.heartbeats[0]).toMatchObject({ state: 'idle', version: 'v1' });
    for (const bad of [{ state: 'sleeping' }, { version: 'x'.repeat(51) }, { last_run_at: 'yesterday' }]) {
      expect((await hb(bad)).statusCode).toBe(400);
    }
    expect(f.heartbeats).toHaveLength(1);
  });

  it('records a run, and announces a failed one at once', async () => {
    const f = await build();
    expect((await runPost(good)).statusCode).toBe(200);
    expect(f.runs[0]).toMatchObject({ status: 'ready', batchId: 'abc12345', accountsReceived: ['a1'], expectedAccounts: ['a1', 'a2'], files: ['w.qbo'] });
    expect((await runPost({ ...good, report: { status: 'failed', error: 'boom' } })).statusCode).toBe(200);
    expect(f.announced.map(r => r.status)).toEqual(['ready', 'failed']);
  });

  it('a failing notification never loses the saved report', async () => {
    const f = await build(fakes({ monitorFails: true }));
    expect((await runPost({ ...good, report: { status: 'failed' } })).statusCode).toBe(200);
    expect(f.runs).toHaveLength(1);
  });

  it('rejects bad run reports', async () => {
    const f = await build();
    const cases = [
      {}, { report: 'x' }, { report: { status: 'weird' } }, { report: { status: 'ready' }, accounts_received: 'a1' },
      { report: { status: 'ready' }, files: Array.from({ length: 201 }, () => 'f') }, { report: { status: 'ready' }, expected_accounts: [1] },
      { report: { status: 'ready', big: 'x'.repeat(260 * 1024) } },     // over 256 KB but inside the body limit
    ];
    for (const c of cases) expect((await runPost(c)).statusCode).toBe(400);
    expect((await runPost({ report: { status: 'ready', big: 'x'.repeat(300 * 1024) } })).statusCode).toBe(413);   // over the body limit
    expect(f.runs).toHaveLength(0);
  });

  it('status and reviewers are for a signed-in person only', async () => {
    await build();
    for (const [method, url] of [['GET', '/api/books/status'], ['GET', '/api/books/reviewers']] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: auth })).statusCode).toBe(401); // the books token does not open owner routes
      expect((await app.inject({ method, url, headers: session })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/books/reviewers', payload: { reviewers: [] } })).statusCode).toBe(401);
  });

  it('saves reviewers, and reports bad input as 400', async () => {
    await build();
    const ok = await app.inject({ method: 'PUT', url: '/api/books/reviewers', headers: session, payload: { reviewers: [{ name: 'K', ntfyTopic: 'k' }] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reviewers).toEqual([{ name: 'K', ntfyTopic: 'k' }]);
    const bad = await app.inject({ method: 'PUT', url: '/api/books/reviewers', headers: session, payload: { reviewers: [1, 2, 3] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('too many');
  });
});
