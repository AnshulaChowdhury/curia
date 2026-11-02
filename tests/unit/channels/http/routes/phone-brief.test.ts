import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneBriefRoutes } from '../../../../../src/channels/http/routes/phone-brief.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const AUTH = { authorization: 'Bearer secret' };
const BRIEF = {
  date: '2026-11-02', generatedAt: '2026-11-02T06:30:00.000-05:00', signalNumber: '+14165550123',
  sections: [{ id: 'accounting' as const, items: [{ text: '12 transactions categorised; 3 need your review' }] }],
};

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function make(opts: { token?: string | null; today?: () => Promise<typeof BRIEF | null> } = {}) {
  const today = vi.fn(opts.today ?? (async () => BRIEF));
  app = Fastify();
  await app.register(phoneBriefRoutes, {
    logger: createSilentLogger(),
    getToken: async () => (opts.token === undefined ? 'secret' : opts.token),
    service: { today },
    now: () => 1_000,
  });
  return { app, today };
}

describe('GET /phone/brief', () => {
  it('is invisible (404) until a token is configured', async () => {
    const { app: a } = await make({ token: null });
    expect((await a.inject({ method: 'GET', url: '/phone/brief', headers: AUTH })).statusCode).toBe(404);
  });

  it('rejects a missing or wrong token without reading the brief', async () => {
    const { app: a, today } = await make();
    for (const authorization of [undefined, 'Bearer nope', 'Bearer ', 'Basic secret']) {
      const res = await a.inject({ method: 'GET', url: '/phone/brief', headers: authorization ? { authorization } : {} });
      expect(res.statusCode, String(authorization)).toBe(401);
    }
    expect(today).not.toHaveBeenCalled();
  });

  it('returns today\'s brief with no-store', async () => {
    const { app: a, today } = await make();
    const res = await a.inject({ method: 'GET', url: '/phone/brief', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(BRIEF);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(today).toHaveBeenCalledWith(1_000);
  });

  it('answers 204 with no body when there is nothing to report', async () => {
    const { app: a } = await make({ today: async () => null });
    const res = await a.inject({ method: 'GET', url: '/phone/brief', headers: AUTH });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('answers 500 without leaking the error', async () => {
    const { app: a } = await make({ today: async () => { throw new Error('db: SECRET'); } });
    const res = await a.inject({ method: 'GET', url: '/phone/brief', headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('SECRET');
  });
});
