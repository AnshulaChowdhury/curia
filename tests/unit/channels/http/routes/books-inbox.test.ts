import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { booksInboxRoutes } from '../../../../../src/channels/http/routes/books-inbox.js';
import { DriveFileError, DriveSettingsError, type DriveInbox } from '../../../../../src/books/drive-inbox.js';
import type { UploadStore } from '../../../../../src/books/upload-store.js';
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

/** An in-memory UploadStore with the same behaviour as the SQL one. */
function fakeUploads(initial: Array<{ id: string; name: string; bytes: Buffer }> = []) {
  const files = new Map(initial.map(f => [f.id, { ...f, status: 'waiting' as 'waiting' | 'processed', sha: f.bytes.toString('hex') }]));
  const store = {
    async add(name: string, bytes: Buffer) {
      const sha = bytes.toString('hex');
      for (const f of files.values()) if (f.sha === sha) return { status: 'duplicate' as const, id: f.id, name: f.name, processed: f.status === 'processed' };
      const id = `00000000-0000-4000-8000-${String(files.size + 1).padStart(12, '0')}`;
      files.set(id, { id, name, bytes, status: 'waiting', sha });
      return { status: 'added' as const, id };
    },
    async list() { return [...files.values()].map(f => ({ id: f.id, name: f.name, size: f.bytes.length, status: f.status, uploaded_at: 'x', processed_at: null })); },
    async listWaiting() { return [...files.values()].filter(f => f.status === 'waiting').map(f => ({ id: f.id, name: f.name, size: f.bytes.length, modifiedTime: '', md5: f.sha })); },
    async read(id: string) { const f = files.get(id); return f && f.status === 'waiting' ? { name: f.name, bytes: f.bytes } : null; },
    async markProcessed(id: string) { const f = files.get(id); if (!f || f.status !== 'waiting') return false; f.status = 'processed'; return true; },
    async remove(id: string) { const f = files.get(id); if (!f || f.status !== 'waiting') return false; files.delete(id); return true; },
  } as unknown as UploadStore;
  return { store, files };
}

describe('books inbox routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(inbox: DriveInbox, token: string | null = TOKEN, uploads: UploadStore = fakeUploads().store) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async req => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    const booksToken = { verify: async (p: string) => (token === null ? null : p === token) } as unknown as BooksToken;
    await app.register(booksInboxRoutes, { logger: createSilentLogger(), driveInbox: inbox, uploads, booksToken, webAppBootstrapSecret: 'boot', sessions });
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

  it('says so when fetching a Drive file and the folder is not set up, or Drive is down', async () => {
    await build(fakeInbox({ read: async () => { throw new DriveSettingsError('not set up'); } }).inbox);
    expect((await app.inject({ method: 'GET', url: `/books/inbox/${ID}/content`, headers: auth })).statusCode).toBe(409);
    await app.close();
    await build(fakeInbox({ read: async () => { throw new Error('boom'); } }).inbox);
    expect((await app.inject({ method: 'GET', url: `/books/inbox/${ID}/content`, headers: auth })).statusCode).toBe(502);
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

  describe('uploads from the Books page', () => {
    const OFX = Buffer.from('OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>');
    const session = { cookie: 'curia_session=sess', 'content-type': 'application/octet-stream' };
    const upload = (name: string, payload: Buffer, headers: Record<string, string> = session) =>
      app.inject({ method: 'POST', url: `/api/books/uploads?name=${encodeURIComponent(name)}`, headers, payload });

    it('needs a signed-in session', async () => {
      await build(fakeInbox().inbox);
      expect((await upload('w.qbo', OFX, { 'content-type': 'application/octet-stream' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/books/uploads' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'DELETE', url: '/api/books/uploads/00000000-0000-4000-8000-000000000001' })).statusCode).toBe(401);
      // the books token is not a session
      expect((await upload('w.qbo', OFX, { ...auth, 'content-type': 'application/octet-stream' })).statusCode).toBe(401);
    });

    it('stores a good file, shows it in the list, and refuses a bad one with the reason', async () => {
      const { store } = fakeUploads();
      await build(fakeInbox().inbox, TOKEN, store);
      const ok = await upload('../../Chequing Oct.qbo', OFX);
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ ok: true, name: 'Chequing Oct.qbo', size: OFX.length });
      const list = await app.inject({ method: 'GET', url: '/api/books/uploads', headers: { cookie: 'curia_session=sess' } });
      expect(list.json().uploads).toHaveLength(1);
      expect(list.body).not.toContain('OFXHEADER');                         // the list never carries file contents
      const bad = await upload('notes.pdf', OFX);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('.qbo');
      expect((await upload('x.qbo', Buffer.from('not a bank file'))).statusCode).toBe(400);
    });

    it('says so when the same file is uploaded again, without storing a second copy', async () => {
      const { store, files } = fakeUploads();
      await build(fakeInbox().inbox, TOKEN, store);
      await upload('w.qbo', OFX);
      const again = await upload('copy of w.qbo', OFX);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ ok: true, duplicate: true });
      expect(files.size).toBe(1);
    });

    it('refuses a file over the size limit', async () => {
      await build(fakeInbox().inbox);
      const big = Buffer.concat([OFX, Buffer.alloc(5 * 1024 * 1024 + 2048, 65)]);
      expect((await upload('big.qbo', big)).statusCode).toBe(413);
    });

    it('removes a waiting file but not one that was already taken', async () => {
      const { store } = fakeUploads();
      await build(fakeInbox().inbox, TOKEN, store);
      const id = (await upload('w.qbo', OFX)).json().id as string;
      const del = (u: string) => app.inject({ method: 'DELETE', url: `/api/books/uploads/${u}`, headers: { cookie: 'curia_session=sess' } });
      expect((await del('not-a-uuid')).statusCode).toBe(400);
      expect((await del(id)).statusCode).toBe(200);
      expect((await del(id)).statusCode).toBe(404);
    });
  });

  describe('the books agent sees uploaded files, with or without Google Drive', () => {
    const ID = '00000000-0000-4000-8000-000000000001';
    const uploaded = () => fakeUploads([{ id: ID, name: 'w.qbo', bytes: Buffer.from('OFXHEADER:100\n<OFX>') }]);

    it('lists uploads even when the Drive folder is not set up or is broken', async () => {
      for (const err of [new DriveSettingsError('not set up'), new Error('403 permission denied')]) {
        await build(fakeInbox({ list: async () => { throw err; } }).inbox, TOKEN, uploaded().store);
        const res = await app.inject({ method: 'GET', url: '/books/inbox', headers: auth });
        expect(res.statusCode).toBe(200);
        expect(res.json().files.map((f: { id: string }) => f.id)).toEqual([ID]);
        await app.close();
      }
    });

    it('lists uploads and Drive files together', async () => {
      await build(fakeInbox().inbox, TOKEN, uploaded().store);
      const ids = (await app.inject({ method: 'GET', url: '/books/inbox', headers: auth })).json().files.map((f: { id: string }) => f.id);
      expect(ids).toEqual([ID, 'fileAAAAAAAA1']);
    });

    it('serves an upload as opaque bytes, and the Drive path is not used for it', async () => {
      const read = { called: 0 };
      await build(fakeInbox({ read: async () => { read.called++; return { name: 'x', bytes: Buffer.from('drive') }; } }).inbox, TOKEN, uploaded().store);
      const res = await app.inject({ method: 'GET', url: `/books/inbox/${ID}/content`, headers: auth });
      expect(res.body).toBe('OFXHEADER:100\n<OFX>');
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(read.called).toBe(0);
    });

    it('marking an upload processed drops its bytes: it is gone from the list and cannot be fetched again', async () => {
      await build(fakeInbox({ list: async () => [] }).inbox, TOKEN, uploaded().store);
      expect((await app.inject({ method: 'POST', url: `/books/inbox/${ID}/processed` })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `/books/inbox/${ID}/processed`, headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/books/inbox', headers: auth })).json().files).toEqual([]);
      expect((await app.inject({ method: 'GET', url: `/books/inbox/${ID}/content`, headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/books/inbox/${ID}/processed`, headers: auth })).statusCode).toBe(404);
    });
  });
});
