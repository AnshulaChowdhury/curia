// contacts-sources.test.ts — GET /api/contacts/import/sources: auth, content, and that nothing sensitive leaves.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { contactsSourcesRoutes } from '../../../../../src/channels/http/routes/contacts-sources.js';
import { InMemoryMailboxCategoryStore } from '../../../../../src/phone-inbox/mailbox-category-store.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const COOKIE = { cookie: 'curia_session=sess' };
const URL_PATH = '/api/contacts/import/sources';

describe('GET /api/contacts/import/sources', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(opts: { vault?: Record<string, string>; store?: InMemoryMailboxCategoryStore; failMailboxes?: boolean } = {}) {
    const vault = new Map(Object.entries(opts.vault ?? {}));
    const store = opts.store ?? new InMemoryMailboxCategoryStore();
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async (req) => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    await app.register(contactsSourcesRoutes, {
      logger: createSilentLogger(),
      secrets: { get: vi.fn(async (k: string) => vault.get(k) ?? null) },
      categories: store,
      loadMailboxes: async () => {
        if (opts.failMailboxes) throw new Error('nylas_region must be us or eu: secret=hunter2');
        return [
          { id: 'personal' as const, address: 'someone@gmail.example', reader: {} as never },
          { id: 'moonray' as const, address: 'ac@moonray.example', reader: {} as never },
          { id: 'work-outlook' as const, address: null, reader: null },
        ];
      },
      webAppBootstrapSecret: 'boot',
      sessions,
    });
    return { store };
  }

  it('needs a console session', async () => {
    await build();
    expect((await app.inject({ method: 'GET', url: URL_PATH })).statusCode).toBe(401);
  });

  it('lists mailboxes, bridges and the two contact apps, uncached', async () => {
    const { store } = await build({ vault: { matrix_bridge_whatsapp_url: 'http://mautrix-whatsapp.railway.internal:29318', matrix_bridge_whatsapp_secret: 'topsecret' } });
    await store.report('moonray', 'WORK');
    const res = await app.inject({ method: 'GET', url: URL_PATH, headers: COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { sources } = res.json() as { sources: { key: string; status: string; willImport: boolean; category: string | null }[] };
    const by = (k: string) => sources.find((s) => s.key === k)!;
    expect(by('mailbox:moonray')).toMatchObject({ status: 'ready', willImport: true, category: 'WORK' });
    expect(by('mailbox:personal')).toMatchObject({ status: 'waiting', willImport: false, category: null });
    expect(by('mailbox:work-outlook')).toMatchObject({ status: 'skipped' });
    expect(by('bridge:whatsapp')).toMatchObject({ status: 'ready', willImport: true });
    expect(by('bridge:signal')).toMatchObject({ status: 'not_connected' });
    expect(by('google_contacts')).toBeDefined();
    expect(by('apple_contacts')).toBeDefined();
  });

  it('never returns a full address, a bridge address or a secret', async () => {
    await build({ vault: { matrix_bridge_whatsapp_url: 'http://mautrix-whatsapp.railway.internal:29318', matrix_bridge_whatsapp_secret: 'topsecret' } });
    const body = (await app.inject({ method: 'GET', url: URL_PATH, headers: COOKIE })).body;
    for (const forbidden of ['someone@gmail.example', 'ac@moonray.example', 'topsecret', 'railway.internal']) expect(body).not.toContain(forbidden);
    expect(body).toContain('s***@gmail.example');
  });

  it('answers 500 with a plain message when the mailboxes cannot be loaded, without leaking the cause', async () => {
    await build({ failMailboxes: true });
    const res = await app.inject({ method: 'GET', url: URL_PATH, headers: COOKIE });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
  });
});
