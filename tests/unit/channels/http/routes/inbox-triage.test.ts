// inbox-triage.test.ts — the Inbox triage settings form: auth, validation, vault writes, write-only token.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { inboxTriageRoutes } from '../../../../../src/channels/http/routes/inbox-triage.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const COOKIE = { cookie: 'curia_session=sess' };
const URL_ = '/api/connections/inbox-triage';

function setup(opts: { fetchImpl?: typeof fetch; reload?: () => Promise<void>; seed?: Record<string, string> } = {}) {
  const vault = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const secrets = {
    get: vi.fn(async (k: string) => vault.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { vault.set(k, v); }),
    delete: vi.fn(async (k: string) => { vault.delete(k); }),
  };
  const controller = {
    reload: vi.fn(opts.reload ?? (async () => {})),
    status: vi.fn(() => ({ running: vault.get('inbox_triage_enabled') === 'true', accounts: ['moonray'] })),
  };
  return { vault, secrets, controller, fetchImpl: opts.fetchImpl };
}

describe('inbox triage settings routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(s: ReturnType<typeof setup>) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    await app.register(inboxTriageRoutes, {
      logger: createSilentLogger(), secrets: s.secrets, controller: s.controller,
      webAppBootstrapSecret: 'boot', sessions, ...(s.fetchImpl ? { fetchImpl: s.fetchImpl } : {}),
    });
  }

  it('refuses everyone who is not signed in', async () => {
    await build(setup());
    expect((await app.inject({ method: 'GET', url: URL_ })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: URL_, payload: { enabled: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${URL_}/test` })).statusCode).toBe(401);
  });

  it('saves to the vault, restarts the watcher, and never returns the token', async () => {
    const s = setup();
    await build(s);
    const res = await app.inject({
      method: 'PUT', url: URL_, headers: COOKIE,
      payload: { enabled: true, ntfyUrl: ' https://ntfy.example.com ', ntfyTopic: 'curia-mail', ntfyToken: 'tk_secret', minConfidence: 0.7 },
    });
    expect(res.statusCode).toBe(200);
    expect(s.vault.get('inbox_triage_enabled')).toBe('true');
    expect(s.vault.get('inbox_triage_ntfy_url')).toBe('https://ntfy.example.com');
    expect(s.vault.get('inbox_triage_ntfy_topic')).toBe('curia-mail');
    expect(s.vault.get('inbox_triage_ntfy_token')).toBe('tk_secret');
    expect(s.vault.get('inbox_triage_min_confidence')).toBe('0.7');
    expect(s.controller.reload).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({ enabled: true, ntfyTopic: 'curia-mail', hasToken: true, minConfidence: 0.7, running: true });
    expect(res.body).not.toContain('tk_secret');
    const got = await app.inject({ method: 'GET', url: URL_, headers: COOKIE });
    expect(got.body).not.toContain('tk_secret');
  });

  it('keeps the stored token when it is omitted, and clears it when sent empty', async () => {
    const s = setup({ seed: { inbox_triage_ntfy_token: 'tk_old' } });
    await build(s);
    await app.inject({ method: 'PUT', url: URL_, headers: COOKIE, payload: { ntfyTopic: 'a' } });
    expect(s.vault.get('inbox_triage_ntfy_token')).toBe('tk_old');
    const res = await app.inject({ method: 'PUT', url: URL_, headers: COOKIE, payload: { ntfyToken: '' } });
    expect(s.vault.has('inbox_triage_ntfy_token')).toBe(false);
    expect(res.json().hasToken).toBe(false);
  });

  it.each([
    [{ enabled: 'yes' }],
    [{ ntfyUrl: 'ftp://x.example.com' }],
    [{ ntfyUrl: 'https://user:pw@ntfy.example.com' }],
    [{ ntfyUrl: 'not a url' }],
    [{ ntfyTopic: 'has space' }],
    [{ ntfyTopic: '../etc' }],
    [{ minConfidence: 0 }],
    [{ minConfidence: 1.5 }],
    [{ minConfidence: '0.5' }],
  ])('rejects %j and writes nothing', async (payload) => {
    const s = setup();
    await build(s);
    const res = await app.inject({ method: 'PUT', url: URL_, headers: COOKIE, payload });
    expect(res.statusCode).toBe(400);
    expect(s.secrets.set).not.toHaveBeenCalled();
    expect(s.controller.reload).not.toHaveBeenCalled();
  });

  it('says so when the watcher cannot restart after a save', async () => {
    const s = setup({ reload: async () => { throw new Error('boom'); } });
    await build(s);
    const res = await app.inject({ method: 'PUT', url: URL_, headers: COOKIE, payload: { enabled: true } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/could not start/);
    expect(s.vault.get('inbox_triage_enabled')).toBe('true');
  });

  it('test push needs saved settings, posts the content-free body, and reports a failure without the URL', async () => {
    const none = setup();
    await build(none);
    expect((await app.inject({ method: 'POST', url: `${URL_}/test`, headers: COOKIE })).statusCode).toBe(400);
    await app.close();

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const ok = setup({ fetchImpl, seed: { inbox_triage_ntfy_url: 'https://ntfy.example.com', inbox_triage_ntfy_topic: 'curia-mail', inbox_triage_ntfy_token: 'tk' } });
    await build(ok);
    const res = await app.inject({ method: 'POST', url: `${URL_}/test`, headers: COOKIE });
    expect(res.json()).toEqual({ ok: true });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ntfy.example.com/curia-mail');
    expect(init.body).toBe('mail');
    await app.close();

    const failing = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    const bad = setup({ fetchImpl: failing, seed: { inbox_triage_ntfy_url: 'https://ntfy.example.com', inbox_triage_ntfy_topic: 'curia-mail' } });
    await build(bad);
    const fail = await app.inject({ method: 'POST', url: `${URL_}/test`, headers: COOKIE });
    expect(fail.statusCode).toBe(502);
    expect(fail.body).toContain('403');
    expect(fail.body).not.toContain('ntfy.example.com');
  });
});
