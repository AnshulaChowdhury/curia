// phone-inbox.test.ts — auth and error behaviour of GET /phone/inbox against a fake service.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneInboxRoutes } from '../../../../../src/channels/http/routes/phone-inbox.js';
import { PhoneInboxUnavailableError, type PhoneInbox, type PhoneInboxService } from '../../../../../src/phone-inbox/phone-inbox-service.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const INBOX: PhoneInbox = {
  updatedAt: '2026-11-01T12:00:00.000Z',
  accounts: [{ id: 'moonray', address: 'ac@example.com', needsYou: 0, unread: 0, items: [] }],
};

let app: FastifyInstance | undefined;

async function makeApp(opts: { token: string | null; build?: () => Promise<PhoneInbox> }) {
  const build = opts.build ?? (async () => INBOX);
  app = Fastify();
  await app.register(phoneInboxRoutes, {
    logger: createSilentLogger(),
    getToken: async () => opts.token,
    getService: async () => ({ build }) as unknown as PhoneInboxService,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /phone/inbox', () => {
  it('is invisible (404) until a token is configured', async () => {
    const a = await makeApp({ token: null });
    const res = await a.inject({ method: 'GET', url: '/phone/inbox', headers: { authorization: 'Bearer anything' } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a missing token', async () => {
    const a = await makeApp({ token: 'secret' });
    const res = await a.inject({ method: 'GET', url: '/phone/inbox' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects a wrong token, a token of a different length, and an empty token', async () => {
    const a = await makeApp({ token: 'secret' });
    for (const header of ['Bearer wrong!', 'Bearer s', 'Bearer ', 'Basic secret', 'secret']) {
      const res = await a.inject({ method: 'GET', url: '/phone/inbox', headers: { authorization: header } });
      expect(res.statusCode, header).toBe(401);
    }
  });

  it('returns the inbox, uncacheable, for the right token', async () => {
    const a = await makeApp({ token: 'secret' });
    const res = await a.inject({ method: 'GET', url: '/phone/inbox', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual(INBOX);
  });

  it('answers 502 when a mailbox cannot be read, without leaking the cause', async () => {
    const a = await makeApp({
      token: 'secret',
      build: async () => { throw new PhoneInboxUnavailableError('personal', new Error('nylas key abc123 rejected')); },
    });
    const res = await a.inject({ method: 'GET', url: '/phone/inbox', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('abc123');
  });

  it('answers 500 on an unexpected failure', async () => {
    const a = await makeApp({ token: 'secret', build: vi.fn().mockRejectedValue(new Error('oops')) });
    const res = await a.inject({ method: 'GET', url: '/phone/inbox', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(500);
  });

  it('does not accept the phone token on other methods', async () => {
    const a = await makeApp({ token: 'secret' });
    const res = await a.inject({ method: 'POST', url: '/phone/inbox', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(404);
  });
});
