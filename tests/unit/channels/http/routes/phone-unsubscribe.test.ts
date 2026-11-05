import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneUnsubscribeRoutes } from '../../../../../src/channels/http/routes/phone-unsubscribe.js';
import { MailboxRateLimitedError } from '../../../../../src/phone-inbox/phone-inbox-service.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const AUTH = { authorization: 'Bearer secret' };
const BODY = { account: 'moonray', messageId: 'm1' };
type Headers = { listUnsubscribe: string | null; listUnsubscribePost: string | null } | null;

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function make(opts: { token?: string | null; headers?: Headers; reader?: 'none' | 'throws' | 'busy'; oneClick?: { ok: boolean; status?: number } } = {}) {
  const read = vi.fn(async () => {
    if (opts.reader === 'throws') throw new Error('nylas down');
    if (opts.reader === 'busy') throw new MailboxRateLimitedError(5);
    return opts.headers === undefined ? { listUnsubscribe: null, listUnsubscribePost: null } : opts.headers;
  });
  const oneClick = vi.fn(async () => (opts.oneClick ?? { ok: true, status: 200 }) as never);
  app = Fastify();
  await app.register(phoneUnsubscribeRoutes, {
    logger: createSilentLogger(),
    getToken: async () => (opts.token === undefined ? 'secret' : opts.token),
    getReader: async () => (opts.reader === 'none' ? null : { read }),
    oneClick,
  });
  return { app, read, oneClick };
}
const post = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = AUTH) =>
  a.inject({ method: 'POST', url: '/phone/unsubscribe', headers, payload: payload as object });

const ONE_CLICK: Headers = { listUnsubscribe: '<https://news.example.com/u?t=secret>, <mailto:u@news.example.com>', listUnsubscribePost: 'List-Unsubscribe=One-Click' };

describe('POST /phone/unsubscribe', () => {
  it('is invisible without a token and rejects a wrong one without reading mail', async () => {
    expect((await post((await make({ token: null })).app, BODY)).statusCode).toBe(404);
    const { app: a, read } = await make();
    expect((await post(a, BODY, { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a bad account or message id', async () => {
    const { app: a, read } = await make();
    for (const payload of [{}, { account: 'nope', messageId: 'm1' }, { account: 'moonray' }, { account: 'moonray', messageId: '' }, { account: 'moonray', messageId: 'x'.repeat(300) }]) {
      expect((await post(a, payload)).statusCode).toBe(400);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('sends the one-click request itself and reports "unsubscribed"', async () => {
    const { app: a, oneClick } = await make({ headers: ONE_CLICK });
    const res = await post(a, BODY);
    expect(res.json()).toEqual({ result: 'unsubscribed' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect((oneClick.mock.calls[0] as unknown as [URL])[0].href).toBe('https://news.example.com/u?t=secret');
  });

  it('hands back the link when the one-click request fails', async () => {
    const { app: a } = await make({ headers: ONE_CLICK, oneClick: { ok: false, status: 500 } });
    expect((await post(a, BODY)).json()).toEqual({ result: 'failed', url: 'https://news.example.com/u?t=secret' });
  });

  it('never requests a link that points inside the network, and hands it back instead', async () => {
    const { app: a, oneClick } = await make({ headers: { listUnsubscribe: '<https://169.254.169.254/latest>', listUnsubscribePost: 'List-Unsubscribe=One-Click' } });
    expect((await post(a, BODY)).json()).toEqual({ result: 'failed', url: 'https://169.254.169.254/latest' });
    expect(oneClick).not.toHaveBeenCalled();
  });

  it('does not POST on its own without one-click support: it returns the link or the mailto address', async () => {
    const link = await make({ headers: { listUnsubscribe: '<https://x.com/u>', listUnsubscribePost: null } });
    expect((await post(link.app, BODY)).json()).toEqual({ result: 'open-link', url: 'https://x.com/u' });
    expect(link.oneClick).not.toHaveBeenCalled();
    await link.app.close();
    const mail = await make({ headers: { listUnsubscribe: '<mailto:u@x.com?subject=unsubscribe>', listUnsubscribePost: null } });
    expect((await post(mail.app, BODY)).json()).toEqual({ result: 'open-mailto', mailto: 'mailto:u@x.com?subject=unsubscribe' });
  });

  it('says "none" when the email has no unsubscribe information', async () => {
    const { app: a } = await make();
    expect((await post(a, BODY)).json()).toEqual({ result: 'none' });
  });

  it('maps mailbox problems: 404 gone, 503 not connected, 429 busy, 502 error', async () => {
    expect((await post((await make({ headers: null })).app, BODY)).statusCode).toBe(404);
    expect((await post((await make({ reader: 'none' })).app, BODY)).statusCode).toBe(503);
    expect((await post((await make({ reader: 'busy' })).app, BODY)).statusCode).toBe(429);
    const broken = await make({ reader: 'throws' });
    const res = await post(broken.app, BODY);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('nylas');
  });
});
