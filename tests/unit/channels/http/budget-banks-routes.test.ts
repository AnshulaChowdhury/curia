import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { budgetBanksRoutes } from '../../../../src/channels/http/routes/budget-banks.js';
import { PlaidError } from '../../../../src/budget/plaid-client.js';
import type { Logger } from '../../../../src/logger.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const SECRET = 'a-long-bootstrap-secret-for-tests-0123456789';
const auth = { 'x-web-bootstrap-secret': SECRET };
const ID = '11111111-1111-4111-8111-111111111111';

async function app(over: Record<string, unknown> = {}) {
  const link = { id: ID, institution: 'Invented Bank', status: 'active', lastError: null, lastSyncedAt: null, accounts: [] };
  const sync = { list: vi.fn(async () => [link]), connect: vi.fn(async () => link), syncOne: vi.fn(async () => 3), syncAll: vi.fn(async () => undefined), remove: vi.fn(async () => true), ...over };
  const plaid = { configured: vi.fn(async () => true), createLinkToken: vi.fn(async () => 'link-sandbox-1') };
  const a = Fastify();
  await a.register(budgetBanksRoutes, { logger, sync: sync as never, plaid, webAppBootstrapSecret: SECRET, sessions: { verify: () => null } as unknown as SessionStore });
  return { a, sync, plaid };
}

describe('/api/budget/banks', () => {
  it('refuses every route without the owner session, before touching Plaid or the store', async () => {
    const { a, sync, plaid } = await app();
    for (const [method, url] of [
      ['GET', '/api/budget/banks'], ['POST', '/api/budget/banks/link-token'], ['POST', '/api/budget/banks'],
      ['POST', '/api/budget/banks/sync'], ['POST', `/api/budget/banks/${ID}/sync`], ['DELETE', `/api/budget/banks/${ID}`],
    ] as const) {
      expect((await a.inject({ method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(401);
    }
    for (const fn of [...Object.values(sync), ...Object.values(plaid)]) expect(fn).not.toHaveBeenCalled();
  });

  it('lists the links and whether Plaid is set up', async () => {
    const { a } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/budget/banks', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ configured: true, links: [{ id: ID, institution: 'Invented Bank' }] });
  });

  it('returns a link token, and connects with a public token', async () => {
    const { a, sync } = await app();
    expect((await a.inject({ method: 'POST', url: '/api/budget/banks/link-token', headers: auth })).json()).toEqual({ linkToken: 'link-sandbox-1' });
    const res = await a.inject({ method: 'POST', url: '/api/budget/banks', headers: auth, payload: { publicToken: 'public-sandbox-abc123', institution: 'Invented Bank' } });
    expect(res.statusCode).toBe(201);
    expect(sync.connect).toHaveBeenCalledWith('public-sandbox-abc123', 'Invented Bank');
    expect((await a.inject({ method: 'POST', url: '/api/budget/banks', headers: auth, payload: {} })).statusCode).toBe(400);
  });

  it('answers 400 when Plaid is not set up, and never leaks an access token', async () => {
    const { a } = await app({ connect: vi.fn(async () => { throw new PlaidError('Plaid is not set up', 'NOT_CONFIGURED', 400); }) });
    const res = await a.inject({ method: 'POST', url: '/api/budget/banks', headers: auth, payload: { publicToken: 'public-sandbox-abc123' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(JSON.stringify(res.json())).not.toMatch(/access/i);
  });

  it('syncs one link, disconnects one, and rejects a bad id', async () => {
    const { a, sync } = await app();
    expect((await a.inject({ method: 'POST', url: `/api/budget/banks/${ID}/sync`, headers: auth })).json()).toEqual({ ok: true, added: 3 });
    expect((await a.inject({ method: 'DELETE', url: `/api/budget/banks/${ID}`, headers: auth })).statusCode).toBe(200);
    expect(sync.remove).toHaveBeenCalledWith(ID);
    expect((await a.inject({ method: 'DELETE', url: '/api/budget/banks/nope', headers: auth })).statusCode).toBe(400);
  });
});
