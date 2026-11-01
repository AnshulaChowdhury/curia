import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { quickbooksRoutes } from './quickbooks.js';
import { QboApiError, QboAuthError, type QboConnection } from '../../../quickbooks/qbo-connection.js';
import { createSilentLogger } from '../../../logger.js';
import { hashToken } from '../session-auth.js';

function fakeConnection(overrides: Partial<Record<keyof QboConnection, unknown>> = {}) {
  const api: Array<[string, string, Record<string, string>, unknown]> = [];
  const conn = {
    authorizationUrl: () => 'https://appcenter.intuit.com/connect/oauth2?state=s',
    handleCallback: async () => {},
    status: async () => ({ configured: true, connected: true }),
    api: async (m: string, p: string, q: Record<string, string>, b: unknown) => {
      api.push([m, p, q, b]);
      return { QueryResponse: {} };
    },
    ...overrides,
  } as unknown as QboConnection;
  return { conn, api };
}

const TOKEN = 'books-secret';
const auth = { authorization: `Bearer ${TOKEN}` };

describe('quickbooks routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(conn: QboConnection, token: string | null = TOKEN) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    // assertSecret reads request.cookies; a tiny stand-in for @fastify/cookie.
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    await app.register(quickbooksRoutes, { logger: createSilentLogger(), connection: conn, getToken: () => token, webAppBootstrapSecret: 'boot', sessions });
  }

  it('connect redirects a signed-in person to Intuit and refuses everyone else', async () => {
    await build(fakeConnection().conn);
    const ok = await app.inject({ method: 'GET', url: '/books/qbo/connect', headers: { cookie: 'curia_session=sess' } });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toContain('appcenter.intuit.com');
    const no = await app.inject({ method: 'GET', url: '/books/qbo/connect' });
    expect(no.statusCode).toBe(401);
  });

  it('connections lists QuickBooks for a signed-in person only, without any token', async () => {
    await build(fakeConnection().conn);
    const ok = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: 'curia_session=sess' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().connections[0]).toMatchObject({ id: 'quickbooks', connected: true, connectUrl: '/books/qbo/connect' });
    expect(ok.body).not.toMatch(/token/i);
    expect((await app.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(401);
  });

  it('callback shows success, and a plain message when the state is bad', async () => {
    await build(fakeConnection().conn);
    const ok = await app.inject({ method: 'GET', url: '/books/qbo-callback?code=c&realmId=1&state=s' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('QuickBooks is connected');
    await app.close();
    await build(fakeConnection({ handleCallback: async () => { throw new QboAuthError('this link has expired'); } }).conn);
    const bad = await app.inject({ method: 'GET', url: '/books/qbo-callback?code=c&realmId=1&state=x' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('this link has expired');
  });

  it('machine routes: 404 without a configured token, 401 without or with a wrong one', async () => {
    await build(fakeConnection().conn, null);
    expect((await app.inject({ method: 'GET', url: '/books/qbo/status', headers: auth })).statusCode).toBe(404);
    await app.close();
    await build(fakeConnection().conn);
    expect((await app.inject({ method: 'GET', url: '/books/qbo/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/books/qbo/status', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/books/qbo/status', headers: auth })).statusCode).toBe(200);
  });

  it('query allows one select on a known entity and nothing else', async () => {
    const { conn, api } = fakeConnection();
    await build(conn);
    const post = (query: unknown) => app.inject({ method: 'POST', url: '/books/qbo/query', headers: auth, payload: { query } as Record<string, unknown> });
    expect((await post('select * from Account STARTPOSITION 1 MAXRESULTS 1000')).statusCode).toBe(200);
    expect(api[0]).toEqual(['GET', 'query', { query: 'select * from Account STARTPOSITION 1 MAXRESULTS 1000' }, undefined]);
    for (const bad of ['delete from Account', 'select * from Secrets', 'select * from Account; select * from Vendor', 7, '']) {
      expect((await post(bad)).statusCode).toBe(400);
    }
    expect(api).toHaveLength(1);
  });

  it('create allows only Purchase, Deposit, Transfer and Vendor, and passes the request id', async () => {
    const { conn, api } = fakeConnection();
    await build(conn);
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/books/qbo/create', headers: auth, payload });
    expect((await post({ entity: 'Purchase', payload: { TotalAmt: 5 }, request_id: 'row-1' })).statusCode).toBe(200);
    expect(api[0]).toEqual(['POST', 'purchase', { requestid: 'row-1' }, { TotalAmt: 5 }]);
    expect((await post({ entity: 'Account', payload: {} })).statusCode).toBe(400);
    expect((await post({ entity: 'Purchase', payload: [] })).statusCode).toBe(400);
    expect((await post({ entity: 'Purchase', payload: {}, request_id: 'bad id!' })).statusCode).toBe(400);
    expect(api).toHaveLength(1);
  });

  it('maps a lost connection to 409 and a QuickBooks refusal to 422 with the fault', async () => {
    await build(fakeConnection({ api: async () => { throw new QboAuthError('press Connect again'); } }).conn);
    const lost = await app.inject({ method: 'POST', url: '/books/qbo/create', headers: auth, payload: { entity: 'Vendor', payload: {} } });
    expect(lost.statusCode).toBe(409);
    expect(lost.json().error).toBe('not_connected');
    await app.close();
    await build(fakeConnection({ api: async () => { throw new QboApiError(400, 'Account is missing', { Error: [] }); } }).conn);
    const refused = await app.inject({ method: 'POST', url: '/books/qbo/create', headers: auth, payload: { entity: 'Vendor', payload: {} } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain('Account is missing');
  });
});
