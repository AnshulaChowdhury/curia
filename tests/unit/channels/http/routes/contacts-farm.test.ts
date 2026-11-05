import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { contactsFarmRoutes } from '../../../../../src/channels/http/routes/contacts-farm.js';
import type { FarmService } from '../../../../../src/channels/http/routes/contacts-farm-types.js';
import { createSilentLogger } from '../../../../../src/logger.js';
import { hashToken } from '../../../../../src/channels/http/session-auth.js';

const COOKIE = { cookie: 'curia_session=sess' };

describe('contacts farm routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());
  async function build(service: Partial<FarmService>, organizations: () => Promise<never[]> = async () => []) {
    app = Fastify();
    const sessions = new Map<string, number>([[hashToken('sess'), Date.now() + 60_000]]);
    app.addHook('onRequest', async (req) => {
      const m = /curia_session=([^;]+)/.exec(req.headers.cookie ?? '');
      (req as unknown as { cookies: Record<string, string> }).cookies = m ? { curia_session: m[1]! } : {};
    });
    await app.register(contactsFarmRoutes, { logger: createSilentLogger(), service: service as FarmService, organizations, webAppBootstrapSecret: 'boot', sessions });
  }

  it('needs a console session', async () => {
    await build({});
    expect((await app.inject({ method: 'GET', url: '/api/contacts/import/farm' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/contacts/import/farm/moonray' })).statusCode).toBe(401);
  });
  it('lists organisations behind the session, uncached', async () => {
    await build({});
    expect((await app.inject({ method: 'GET', url: '/api/contacts/import/organizations' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/contacts/import/organizations', headers: COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ organizations: [] });
  });
  it('lists progress uncached', async () => {
    await build({ status: async () => [] });
    const res = await app.inject({ method: 'GET', url: '/api/contacts/import/farm', headers: COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
  it('starts a scan (202), passing resume', async () => {
    const start = vi.fn(async () => ({ ok: true as const }));
    await build({ start });
    const res = await app.inject({ method: 'POST', url: '/api/contacts/import/farm/moonray', headers: COOKIE, payload: { resume: true } });
    expect(res.statusCode).toBe(202);
    expect(start).toHaveBeenCalledWith('moonray', true);
  });
  it.each([['unknown_account', 404], ['already_running', 409], ['no_category', 400], ['skipped', 400], ['not_connected', 400]] as const)('maps %s to %i', async (reason, code) => {
    await build({ start: async () => ({ ok: false as const, reason, message: 'x' }) });
    expect((await app.inject({ method: 'POST', url: '/api/contacts/import/farm/moonray', headers: COOKIE })).statusCode).toBe(code);
  });
});
