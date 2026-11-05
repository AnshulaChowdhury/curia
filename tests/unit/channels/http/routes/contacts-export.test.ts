import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { contactsExportRoutes } from '../../../../../src/channels/http/routes/contacts-export.js';
import { InMemoryExportStore } from '../../../../../src/contacts-import/export-store.js';
import { ContactsImportToken } from '../../../../../src/contacts-import/import-token.js';
import { parseRooms } from '../../../../../src/contacts-import/export-validate.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const COOKIE = { cookie: 'curia_session=sess' };
const room = (over: object = {}) => ({ roomHash: 'abcdef0123456789', network: 'whatsapp', members: [{ ghostId: '14155550142', fromThem: 3, fromMe: 2, phone: '+14155550142', displayName: 'Dana' }], ...over });

describe('contacts export routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(withToken = true) {
    const vault = new Map<string, string>();
    const importToken = new ContactsImportToken({ get: async (k) => vault.get(k) ?? null, set: async (k, v) => { vault.set(k, v); } });
    const token = withToken ? await importToken.generate() : '';
    const store = new InMemoryExportStore();
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async (req) => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    await app.register(contactsExportRoutes, { logger: createSilentLogger(), store, importToken, webAppBootstrapSecret: 'boot', sessions });
    const auth = { authorization: `Bearer ${token}` };
    return { store, auth };
  }

  it('is 404 until a token exists, 401 with the wrong one', async () => {
    await build(false);
    expect((await app.inject({ method: 'GET', url: '/contacts/export/ping' })).statusCode).toBe(404);
    await app.close();
    await build(true);
    expect((await app.inject({ method: 'GET', url: '/contacts/export/ping' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/contacts/export/ping', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('console: asking for a run needs a session and a token; asking twice returns the open run', async () => {
    const { auth } = await build(true);
    expect((await app.inject({ method: 'POST', url: '/api/contacts/export/request' })).statusCode).toBe(401);
    const a = await app.inject({ method: 'POST', url: '/api/contacts/export/request', headers: COOKIE });
    expect(a.statusCode).toBe(202);
    const b = await app.inject({ method: 'POST', url: '/api/contacts/export/request', headers: COOKIE });
    expect(b.statusCode).toBe(200);
    expect(b.json().runId).toBe(a.json().runId);
    const claim = await app.inject({ method: 'GET', url: '/contacts/export/run-request', headers: auth });
    expect(claim.json()).toMatchObject({ runId: a.json().runId, doneRooms: [] });
  });

  it('no open run is 204; a console request without a token is refused', async () => {
    const { auth } = await build(true);
    expect((await app.inject({ method: 'GET', url: '/contacts/export/run-request', headers: auth })).statusCode).toBe(204);
    await app.close();
    await build(false);
    expect((await app.inject({ method: 'POST', url: '/api/contacts/export/request', headers: COOKIE })).statusCode).toBe(409);
  });

  it('stores rooms, remembers them as done, and a repeat does not duplicate', async () => {
    const { auth, store } = await build(true);
    const { runId } = (await app.inject({ method: 'POST', url: '/api/contacts/export/request', headers: COOKIE })).json();
    await app.inject({ method: 'GET', url: '/contacts/export/run-request', headers: auth });
    const post = () => app.inject({ method: 'POST', url: '/contacts/export/rooms', headers: auth, payload: { runId, rooms: [room()] } });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    expect(await store.countFacts()).toBe(1);
    const again = await app.inject({ method: 'GET', url: '/contacts/export/run-request', headers: auth });
    expect(again.json().doneRooms).toEqual(['abcdef0123456789']);
    const status = await app.inject({ method: 'GET', url: '/api/contacts/export/status', headers: COOKIE });
    expect(status.json()).toMatchObject({ tokenSet: true, partnerRows: 1, run: { status: 'running', roomsDone: 1 } });
  });

  it('finishing closes the run; later posts are refused', async () => {
    const { auth } = await build(true);
    const { runId } = (await app.inject({ method: 'POST', url: '/api/contacts/export/request', headers: COOKIE })).json();
    expect((await app.inject({ method: 'POST', url: '/contacts/export/finish', headers: auth, payload: { runId, status: 'done' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/contacts/export/rooms', headers: auth, payload: { runId, rooms: [room()] } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/contacts/export/finish', headers: auth, payload: { runId, status: 'weird' } })).statusCode).toBe(400);
  });
});

describe('parseRooms', () => {
  it('accepts counts, a name, a phone and dates', () => {
    expect(parseRooms({ rooms: [room({ members: [{ ghostId: 'g1', fromThem: 1, fromMe: 0, firstSeen: '2020-01-01T00:00:00Z' }] })] }).ok).toBe(true);
  });
  it.each([
    ['message text smuggled in a member', { members: [{ ghostId: 'g1', fromThem: 1, fromMe: 0, body: 'hello' }] }],
    ['a raw room id', { roomHash: '!abc:example.org' }],
    ['an unknown network', { network: 'telegram' }],
    ['a field on the room', { roomId: '!x:y' }],
    ['a negative count', { members: [{ ghostId: 'g1', fromThem: -1, fromMe: 0 }] }],
    ['a phone that is not E.164', { members: [{ ghostId: 'g1', fromThem: 1, fromMe: 0, phone: '4155550142' }] }],
  ])('refuses %s', (_n, over) => {
    expect(parseRooms({ rooms: [room(over)] }).ok).toBe(false);
  });
  it('refuses empty and oversized batches', () => {
    expect(parseRooms({ rooms: [] }).ok).toBe(false);
    expect(parseRooms({ rooms: Array.from({ length: 51 }, () => room()) }).ok).toBe(false);
  });
});
