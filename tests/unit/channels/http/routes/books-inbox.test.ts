import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { booksInboxRoutes } from '../../../../../src/channels/http/routes/books-inbox.js';
import { DriveFileError, DriveSettingsError, type DriveInbox } from '../../../../../src/books/drive-inbox.js';
import type { BooksToken } from '../../../../../src/quickbooks/books-token.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const TOKEN = 'books-secret';
const auth = { authorization: `Bearer ${TOKEN}` };
const ID = 'fileAAAAAAAA1';

function fakeInbox(overrides: Partial<Record<keyof DriveInbox, unknown>> = {}) {
  const calls: string[] = [];
  const inbox = {
    status: async () => ({ configured: true, reachable: true }),
    saveSettings: async (i: unknown) => { calls.push('save ' + JSON.stringify(i)); return { serviceAccountEmail: 'sa@x.iam', folderName: 'Bank files' }; },
    list: async () => [{ id: ID, name: 'w.qbo', size: 10, modifiedTime: '', md5: '' }],
    read: async () => ({ name: 'w.qbo', bytes: Buffer.from('OFXHEADER:100') }),
    markProcessed: async (id: string) => { calls.push('processed ' + id); },
    ...overrides,
  } as unknown as DriveInbox;
  return { inbox, calls };
}

describe('books inbox routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(inbox: DriveInbox, token: string | null = TOKEN) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    const booksToken = { verify: async (p: string) => (token === null ? null : p === token) } as unknown as BooksToken;
    await app.register(booksInboxRoutes, { logger: createSilentLogger(), driveInbox: inbox, booksToken, webAppBootstrapSecret: 'boot', sessions });
  }

  it('machine routes need the books token (404 if none exists, 401 if wrong)', async () => {
    await build(fakeInbox().inbox);
    expect((await app.inject({ method: 'GET', url: '/books/inbox' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/books/inbox', headers: { authorization: 'Bearer no' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/books/inbox', headers: auth })).statusCode).toBe(200);
    await app.close();
    await build(fakeInbox().inbox, null);
    expect((await app.inject({ method: 'GET', url: '/books/inbox', headers: auth })).statusCode).toBe(404);
  });

  it('lists files, and serves one as opaque uncached bytes', async () => {
    await build(fakeInbox().inbox);
    const list = await app.inject({ method: 'GET', url: '/books/inbox', headers: auth });
    expect(list.json().files[0]).toMatchObject({ id: ID, name: 'w.qbo' });
    const body = await app.inject({ method: 'GET', url: `/books/inbox/${ID}/content`, headers: auth });
    expect(body.statusCode).toBe(200);
    expect(body.body).toBe('OFXHEADER:100');
    expect(body.headers['content-type']).toBe('application/octet-stream');
    expect(body.headers['cache-control']).toBe('no-store');
    expect(body.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects a malformed file id before touching Drive, and maps a foreign file to 404', async () => {
    const { inbox } = fakeInbox({ read: async () => { throw new DriveFileError('That file is not in the bank files folder'); } });
    await build(inbox);
    expect((await app.inject({ method: 'GET', url: '/books/inbox/..%2Fetc/content', headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/books/inbox/short/content', headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/books/inbox/${ID}/content`, headers: auth })).statusCode).toBe(404);
  });

  it('marks processed through the books token only', async () => {
    const { inbox, calls } = fakeInbox();
    await build(inbox);
    expect((await app.inject({ method: 'POST', url: `/books/inbox/${ID}/processed` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/books/inbox/${ID}/processed`, headers: auth })).statusCode).toBe(200);
    expect(calls).toEqual(['processed ' + ID]);
  });

  it('says so when the folder is not set up, and when Drive is down', async () => {
    await build(fakeInbox({ list: async () => { throw new DriveSettingsError('not set up'); } }).inbox);
    expect((await app.inject({ method: 'GET', url: '/books/inbox', headers: auth })).statusCode).toBe(409);
    await app.close();
    await build(fakeInbox({ list: async () => { throw new Error('boom'); } }).inbox);
    expect((await app.inject({ method: 'GET', url: '/books/inbox', headers: auth })).statusCode).toBe(502);
  });

  it('settings and status are for a signed-in person only, and the key is never returned', async () => {
    const { inbox, calls } = fakeInbox();
    await build(inbox);
    const put = (headers: Record<string, string> = {}) =>
      app.inject({ method: 'PUT', url: '/api/connections/drive/settings', headers, payload: { serviceAccountJson: '{"k":1}', folder: 'f' } });
    expect((await put()).statusCode).toBe(401);
    const ok = await put({ cookie: 'curia_session=sess' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, serviceAccountEmail: 'sa@x.iam' });
    expect(calls).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/connections/drive' })).statusCode).toBe(401);
    const st = await app.inject({ method: 'GET', url: '/api/connections/drive', headers: { cookie: 'curia_session=sess' } });
    expect(st.json()).toMatchObject({ configured: true });
  });

  it('reports bad settings as 400 with the reason', async () => {
    await build(fakeInbox({ saveSettings: async () => { throw new DriveSettingsError('Share the folder with sa@x.iam'); } }).inbox);
    const res = await app.inject({ method: 'PUT', url: '/api/connections/drive/settings', headers: { cookie: 'curia_session=sess' }, payload: { serviceAccountJson: 'x', folder: 'y' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Share the folder');
  });
});
