// contacts-import-run.test.ts — Preview and Apply routes: auth, validation, status codes, nothing sensitive in errors.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { contactsImportRunRoutes } from '../../../../../src/channels/http/routes/contacts-import-run.js';
import { PullError, type ContactsPullService } from '../../../../../src/contacts-import/pull-service.js';
import { ImportError } from '../../../../../src/contacts-import/import-service.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const COOKIE = { cookie: 'curia_session=sess' };
const RUN = 'pull-abc123-0123abcd';

describe('contacts import run routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(service: Partial<ContactsPullService>) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async (req) => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    await app.register(contactsImportRunRoutes, {
      logger: createSilentLogger(), getService: async () => service as ContactsPullService, webAppBootstrapSecret: 'boot', sessions,
    });
  }

  it('both routes need a console session', async () => {
    await build({});
    expect((await app.inject({ method: 'POST', url: '/api/contacts/import/preview' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/contacts/import/apply', payload: { runId: RUN } })).statusCode).toBe(401);
  });

  it('preview returns the result uncached', async () => {
    const preview = vi.fn(async () => ({ runId: RUN, totals: { people: 1, create: 1, attach: 0, review: 0 } }));
    await build({ preview } as never);
    const res = await app.inject({ method: 'POST', url: '/api/contacts/import/preview', headers: COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ runId: RUN });
  });

  it('preview says 409 when nothing was found and 500 without leaking the cause', async () => {
    await build({ preview: async () => { throw new PullError('nothing_to_import', 'No people were found in the connected sources.'); } } as never);
    const none = await app.inject({ method: 'POST', url: '/api/contacts/import/preview', headers: COOKIE });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: 'nothing_to_import' });
    await app.close();
    await build({ preview: async () => { throw new Error('connect ECONNREFUSED http://mautrix-x.railway.internal secret=hunter2'); } } as never);
    const boom = await app.inject({ method: 'POST', url: '/api/contacts/import/preview', headers: COOKIE });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain('hunter2');
    expect(boom.body).not.toContain('railway.internal');
  });

  it('apply rejects a missing or malformed run id before touching anything', async () => {
    const apply = vi.fn();
    await build({ apply } as never);
    for (const payload of [{}, { runId: 5 }, { runId: '../etc' }, { runId: 'pull-ABC-1' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/contacts/import/apply', headers: COOKIE, payload })).statusCode).toBe(400);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('apply maps its errors: unknown 404, expired 409, already applied 409, anything else 500', async () => {
    const run = async (err: Error) => {
      await build({ apply: async () => { throw err; } } as never);
      const res = await app.inject({ method: 'POST', url: '/api/contacts/import/apply', headers: COOKIE, payload: { runId: RUN } });
      await app.close();
      return res.statusCode;
    };
    expect(await run(new PullError('unknown_run', 'x'))).toBe(404);
    expect(await run(new PullError('preview_expired', 'x'))).toBe(409);
    expect(await run(new ImportError('already_applied', 'x'))).toBe(409);
    expect(await run(new Error('db password=hunter2'))).toBe(500);
  });

  it('apply returns the totals', async () => {
    await build({ apply: async () => ({ runId: RUN, totals: { created: 2, attached: 0, skipped: 0, failed: 0 } }) } as never);
    const res = await app.inject({ method: 'POST', url: '/api/contacts/import/apply', headers: COOKIE, payload: { runId: RUN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totals: { created: 2 } });
  });
});
