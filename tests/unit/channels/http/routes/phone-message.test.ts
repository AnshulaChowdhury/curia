// phone-message.test.ts — auth, validation and error behaviour of GET /phone/message against a fake reader.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneMessageRoutes } from '../../../../../src/channels/http/routes/phone-message.js';
import { NylasMailboxError } from '../../../../../src/phone-inbox/nylas-mailbox.js';
import type { NylasMessageReader } from '../../../../../src/phone-inbox/nylas-message.js';
import { MailboxRateLimitedError } from '../../../../../src/phone-inbox/phone-inbox-service.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const AUTH = { authorization: 'Bearer secret' };
const URL_ = '/phone/message?account=moonray&threadId=t1';

let app: FastifyInstance | undefined;

async function makeApp(opts: { token?: string | null; read?: (threadId: string, messageId?: string) => Promise<{ body: string; truncated: boolean } | null>; connected?: boolean } = {}) {
  const read = vi.fn(opts.read ?? (async () => ({ body: 'Hello', truncated: false })));
  app = Fastify();
  await app.register(phoneMessageRoutes, {
    logger: createSilentLogger(),
    getToken: async () => (opts.token === undefined ? 'secret' : opts.token),
    getReader: async () => (opts.connected === false ? null : ({ read } as unknown as NylasMessageReader)),
  });
  return { app, read };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /phone/message', () => {
  it('is invisible (404) until a token is configured', async () => {
    const { app: a } = await makeApp({ token: null });
    expect((await a.inject({ method: 'GET', url: URL_, headers: AUTH })).statusCode).toBe(404);
  });

  it('rejects a missing, wrong, or different-length token without reading mail', async () => {
    const { app: a, read } = await makeApp();
    for (const header of [undefined, 'Bearer wrong!', 'Bearer s', 'Bearer ', 'Basic secret', 'secret']) {
      const res = await a.inject({ method: 'GET', url: URL_, headers: header ? { authorization: header } : {} });
      expect(res.statusCode, String(header)).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('returns the text with no-store and passes the ids through', async () => {
    const { app: a, read } = await makeApp();
    const res = await a.inject({ method: 'GET', url: `${URL_}&messageId=m1`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: 'Hello', truncated: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(read).toHaveBeenCalledWith('t1', 'm1');
  });

  it.each([
    ['/phone/message?threadId=t1'],
    ['/phone/message?account=gmail&threadId=t1'],
    ['/phone/message?account=moonray'],
    ['/phone/message?account=moonray&threadId='],
    [`/phone/message?account=moonray&threadId=${'x'.repeat(257)}`],
    ['/phone/message?account=moonray&threadId=t1&messageId='],
  ])('rejects %s with 400 and reads nothing', async (url) => {
    const { app: a, read } = await makeApp();
    expect((await a.inject({ method: 'GET', url, headers: AUTH })).statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('404s when the email is gone or the mailbox is not connected', async () => {
    const gone = await makeApp({ read: async () => null });
    expect((await gone.app.inject({ method: 'GET', url: URL_, headers: AUTH })).statusCode).toBe(404);
    await app?.close();
    const off = await makeApp({ connected: false });
    expect((await off.app.inject({ method: 'GET', url: URL_, headers: AUTH })).statusCode).toBe(404);
    expect(off.read).not.toHaveBeenCalled();
  });

  it('maps a rate limit to 503 with Retry-After, and a Nylas failure to 502 without detail', async () => {
    const limited = await makeApp({ read: async () => { throw new MailboxRateLimitedError(9); } });
    const res = await limited.app.inject({ method: 'GET', url: URL_, headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('9');
    await app?.close();

    const down = await makeApp({ read: async () => { throw new NylasMailboxError(500, 'message'); } });
    const res2 = await down.app.inject({ method: 'GET', url: URL_, headers: AUTH });
    expect(res2.statusCode).toBe(502);
    expect(res2.body).not.toContain('500');
  });

  it('answers 500 without leaking the error for anything unexpected', async () => {
    const { app: a } = await makeApp({ read: async () => { throw new Error('boom: SECRET'); } });
    const res = await a.inject({ method: 'GET', url: URL_, headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('SECRET');
  });
});
