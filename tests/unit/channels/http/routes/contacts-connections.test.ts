// contacts-connections.test.ts — the contacts cards on the connections page: auth, validation, vault names,
// write-only secrets, content-free test results, and the import token shown once.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { contactsConnectionsRoutes } from '../../../../../src/channels/http/routes/contacts-connections.js';
import { ContactsImportToken } from '../../../../../src/contacts-import/import-token.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const COOKIE = { cookie: 'curia_session=sess' };
const BR = '/api/connections/matrix-bridges';
const GOOD_URL = 'http://mautrix-signal.railway.internal:29328';

function setup(opts: { fetchImpl?: typeof fetch; seed?: Record<string, string> } = {}) {
  const vault = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const secrets = {
    get: vi.fn(async (k: string) => vault.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { vault.set(k, v); }),
    delete: vi.fn(async (k: string) => { vault.delete(k); }),
  };
  return { vault, secrets, fetchImpl: opts.fetchImpl };
}

describe('contacts connections routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(s: ReturnType<typeof setup>) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    await app.register(contactsConnectionsRoutes, {
      logger: createSilentLogger(), secrets: s.secrets, importToken: new ContactsImportToken({
        get: s.secrets.get, set: s.secrets.set,
      }), webAppBootstrapSecret: 'boot', sessions, ...(s.fetchImpl ? { fetchImpl: s.fetchImpl } : {}),
    });
  }

  it('refuses everyone who is not signed in', async () => {
    await build(setup());
    for (const [method, url] of [
      ['GET', BR], ['PUT', `${BR}/signal`], ['POST', `${BR}/signal/test`],
      ['GET', '/api/connections/contacts-import'], ['POST', '/api/connections/contacts-import-token'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lists the four bridges and never returns a saved secret', async () => {
    const s = setup({ seed: { matrix_bridge_signal_url: GOOD_URL, matrix_bridge_signal_secret: 'sek_signal' } });
    await build(s);
    const res = await app.inject({ method: 'GET', url: BR, headers: COOKIE });
    expect(res.statusCode).toBe(200);
    const bridges = res.json().bridges as Array<{ id: string; url: string; hasSecret: boolean }>;
    expect(bridges.map(b => b.id)).toEqual(['whatsapp', 'gmessages', 'signal', 'instagram']);
    expect(bridges.find(b => b.id === 'signal')).toMatchObject({ url: GOOD_URL, hasSecret: true });
    expect(bridges.find(b => b.id === 'whatsapp')).toMatchObject({ url: '', hasSecret: false });
    expect(res.body).not.toContain('sek_signal');
  });

  it('saves the address and secret under the fixed vault names only, write-only', async () => {
    const s = setup();
    await build(s);
    const res = await app.inject({ method: 'PUT', url: `${BR}/signal`, headers: COOKIE, payload: { url: ` ${GOOD_URL} `, secret: 'sek_new' } });
    expect(res.statusCode).toBe(200);
    expect([...s.vault.keys()].sort()).toEqual(['matrix_bridge_signal_secret', 'matrix_bridge_signal_url']);
    expect(s.vault.get('matrix_bridge_signal_url')).toBe(GOOD_URL);
    expect(s.vault.get('matrix_bridge_signal_secret')).toBe('sek_new');
    expect(res.json()).toMatchObject({ id: 'signal', url: GOOD_URL, hasSecret: true });
    expect(res.body).not.toContain('sek_new');
  });

  it('keeps the secret when omitted and clears it when sent empty', async () => {
    const s = setup({ seed: { matrix_bridge_signal_secret: 'sek_old', matrix_bridge_signal_url: GOOD_URL } });
    await build(s);
    await app.inject({ method: 'PUT', url: `${BR}/signal`, headers: COOKIE, payload: { url: GOOD_URL } });
    expect(s.vault.get('matrix_bridge_signal_secret')).toBe('sek_old');
    const res = await app.inject({ method: 'PUT', url: `${BR}/signal`, headers: COOKIE, payload: { secret: '' } });
    expect(s.vault.has('matrix_bridge_signal_secret')).toBe(false);
    expect(res.json().hasSecret).toBe(false);
  });

  it('refuses unknown bridges, so no arbitrary vault key can be written', async () => {
    const s = setup();
    await build(s);
    for (const id of ['bogus', '..%2Fapi_token', 'whatsapp_url']) {
      const res = await app.inject({ method: 'PUT', url: `${BR}/${id}`, headers: COOKIE, payload: { secret: 'x' } });
      expect(res.statusCode, id).toBe(404);
    }
    expect(s.vault.size).toBe(0);
  });

  it.each([
    [{ url: 'https://bridge.example.com' }, /private network/],
    [{ url: 'http://u:p@mautrix-signal.railway.internal:29328' }, /username/],
    [{ url: 42 }, /text/],
    [{ secret: 42 }, /text/],
    [{ secret: 'x'.repeat(513) }, /512/],
  ])('rejects bad input %j', async (payload, message) => {
    const s = setup();
    await build(s);
    const res = await app.inject({ method: 'PUT', url: `${BR}/signal`, headers: COOKIE, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
    expect(s.vault.size).toBe(0);
  });

  it('will not test until both the address and the secret are saved', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await build(setup({ seed: { matrix_bridge_signal_url: GOOD_URL }, fetchImpl }));
    const res = await app.inject({ method: 'POST', url: `${BR}/signal/test`, headers: COOKIE });
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never sends the secret to a public address, even if one is in the vault', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await build(setup({ seed: { matrix_bridge_signal_url: 'https://bridge.example.com', matrix_bridge_signal_secret: 'sek' }, fetchImpl }));
    const res = await app.inject({ method: 'POST', url: `${BR}/signal/test`, headers: COOKIE });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not allowed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tests a bridge and returns counts only', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/whoami')
        ? new Response(JSON.stringify({ network: { network_id: 'signal' }, logins: [{ id: 'L1', state_event: 'CONNECTED' }] }), { status: 200 })
        : new Response(JSON.stringify({ contacts: [{ id: 'c1', name: 'Test Person', identifiers: ['tel:+15550100'] }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    await build(setup({ seed: { matrix_bridge_signal_url: GOOD_URL, matrix_bridge_signal_secret: 'sek' }, fetchImpl }));
    const res = await app.inject({ method: 'POST', url: `${BR}/signal/test`, headers: COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, contacts: 1, withPhone: 1, network: 'signal' });
    for (const leak of ['Test Person', '5550100', 'L1', 'sek']) expect(res.body).not.toContain(leak);
  });

  it('reports a bridge that is not logged in as a failed test, not a server error', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ network: { network_id: 'instagram' }, logins: [] }), { status: 200 })) as unknown as typeof fetch;
    await build(setup({ seed: { matrix_bridge_instagram_url: 'http://mautrix-instagram.railway.internal:29330', matrix_bridge_instagram_secret: 'sek' }, fetchImpl }));
    const res = await app.inject({ method: 'POST', url: `${BR}/instagram/test`, headers: COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, loginState: 'none' });
  });

  it('makes the import token once, stores only its hash, and reports it as set', async () => {
    const s = setup();
    await build(s);
    expect((await app.inject({ method: 'GET', url: '/api/connections/contacts-import', headers: COOKIE })).json()).toEqual({ tokenSet: false });
    const made = await app.inject({ method: 'POST', url: '/api/connections/contacts-import-token', headers: COOKIE });
    const token = made.json().token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect([...s.vault.keys()]).toEqual(['contacts_import_token_hash']);
    expect([...s.vault.values()].join()).not.toContain(token);
    const after = await app.inject({ method: 'GET', url: '/api/connections/contacts-import', headers: COOKIE });
    expect(after.json()).toEqual({ tokenSet: true });
    expect(after.body).not.toContain(token);
  });
});
