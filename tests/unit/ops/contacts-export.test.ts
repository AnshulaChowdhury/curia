// The contacts exporter (jobs/contacts-export, Python, standard library only): its own unit tests, and one end-to-end
// check that its Curia client speaks the contract the real routes implement.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { contactsExportRoutes } from '../../../src/channels/http/routes/contacts-export.js';
import { InMemoryExportStore } from '../../../src/contacts-import/export-store.js';
import { ContactsImportToken } from '../../../src/contacts-import/import-token.js';
import { createSilentLogger } from '../../../src/logger.js';
import { hashToken } from '../../../src/channels/http/session-auth.js';

const DIR = join(import.meta.dirname, '../../../jobs/contacts-export');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const describePy = python ? describe : describe.skip;

describePy('contacts exporter (python)', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('its own unit tests pass', () => {
    const r = spawnSync(python!, ['-I', '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py'], { cwd: DIR, encoding: 'utf8' });
    expect(r.stderr).toContain('OK');
    expect(r.status).toBe(0);
  });

  it('its Curia client speaks the contract the routes implement', async () => {
    const vault = new Map<string, string>();
    const importToken = new ContactsImportToken({ get: async (k) => vault.get(k) ?? null, set: async (k, v) => { vault.set(k, v); } });
    const token = await importToken.generate();
    const store = new InMemoryExportStore();
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async (req) => { (req as unknown as { cookies: Record<string, string> }).cookies = { curia_session: 'sess' }; });
    await app.register(contactsExportRoutes, { logger: createSilentLogger(), store, importToken, webAppBootstrapSecret: 'boot', sessions });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    expect((await app.inject({ method: 'POST', url: '/api/contacts/export/request' })).statusCode).toBe(202);

    const script = [
      'from contacts_export.curia import Curia',
      `c = Curia("http://127.0.0.1:${port}", ${JSON.stringify(token)})`,
      'assert c.ping()["ok"] is True',
      'req = c.run_request()',
      'assert req["doneRooms"] == [], req',
      'c.post_rooms(req["runId"], [{"roomHash": "abcdef0123456789", "network": "whatsapp", "members": [{"ghostId": "14155550142", "fromThem": 2, "fromMe": 1, "phone": "+14155550142", "firstSeen": "2020-01-01T00:00:00Z", "lastSeen": "2024-01-01T00:00:00Z"}]}])',
      'assert c.run_request()["doneRooms"] == ["abcdef0123456789"]',
      'c.finish(req["runId"], "done")',
      'assert c.run_request() is None',
    ].join('\n');
    const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const p = spawn(python!, ['-c', script], { cwd: DIR });
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('close', (code) => resolve({ code, err }));
    });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(await store.countFacts()).toBe(1);
    expect((await store.latest())!.status).toBe('done');
  });
});
