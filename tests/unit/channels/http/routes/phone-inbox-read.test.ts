import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneInboxReadRoutes } from '../../../../../src/channels/http/routes/phone-inbox-read.js';
import { MailboxRateLimitedError } from '../../../../../src/phone-inbox/phone-inbox-service.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const AUTH = { authorization: 'Bearer secret' };
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function make(opts: { token?: string | null; markRead?: (id: string) => Promise<true>; connected?: string[] } = {}) {
  const markRead = vi.fn(opts.markRead ?? (async () => true as const));
  const invalidate = vi.fn();
  const connected = opts.connected ?? ['moonray', 'personal', 'work_outlook'];
  app = Fastify();
  await app.register(phoneInboxReadRoutes, {
    logger: createSilentLogger(),
    getToken: async () => (opts.token === undefined ? 'secret' : opts.token),
    getMarker: async (account) => (connected.includes(account) ? { markRead } : null),
    invalidate,
  });
  return { app, markRead, invalidate };
}
const post = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = AUTH) =>
  a.inject({ method: 'POST', url: '/phone/inbox/read', headers, payload: payload as object });

describe('POST /phone/inbox/read', () => {
  it('is invisible without a token and rejects a wrong or missing one', async () => {
    expect((await post((await make({ token: null })).app, { items: [{ account: 'moonray', threadId: 't' }] })).statusCode).toBe(404);
    const { app: a, markRead } = await make();
    expect((await post(a, { items: [{ account: 'moonray', threadId: 't' }] }, {})).statusCode).toBe(401);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('marks each thread read, de-duplicates, and drops the cached inbox of the mailboxes it touched', async () => {
    const { app: a, markRead, invalidate } = await make();
    const res = await post(a, { items: [
      { account: 'moonray', threadId: 't1' }, { account: 'moonray', threadId: 't1' }, { account: 'personal', threadId: 't2' },
    ] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, marked: 2, failed: 0, failedItems: [] });
    expect(markRead.mock.calls.map((c) => c[0])).toEqual(['t1', 't2']);
    expect(invalidate.mock.calls.map((c) => c[0]).sort()).toEqual(['moonray', 'personal']);
  });

  it('rejects bad input with 400 and touches nothing', async () => {
    const { app: a, markRead } = await make();
    const bad = [
      {}, { items: [] }, { items: 'x' }, { items: [{ account: 'nope', threadId: 't' }] }, { items: [{ account: 'moonray' }] },
      { items: [{ account: 'moonray', threadId: '' }] }, { items: [{ account: 'moonray', threadId: 'x'.repeat(300) }] },
      { items: Array.from({ length: 51 }, (_, i) => ({ account: 'moonray', threadId: `t${i}` })) },
    ];
    for (const body of bad) expect((await post(a, body)).statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('accepts exactly 50 threads', async () => {
    const { app: a, markRead } = await make();
    const res = await post(a, { items: Array.from({ length: 50 }, (_, i) => ({ account: 'moonray', threadId: `t${i}` })) });
    expect(res.statusCode).toBe(200);
    expect(markRead).toHaveBeenCalledTimes(50);
  });

  it('reports the threads that failed while the rest succeed (200)', async () => {
    const { app: a, invalidate } = await make({ markRead: async (id) => { if (id === 'bad') throw new Error('Nylas thread failed with status 500'); return true; } });
    const res = await post(a, { items: [{ account: 'moonray', threadId: 'ok' }, { account: 'moonray', threadId: 'bad' }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, marked: 1, failed: 1, failedItems: [{ account: 'moonray', threadId: 'bad' }] });
    expect(invalidate).toHaveBeenCalledWith('moonray');
  });

  it('502 when nothing could be written, and the cache is left alone', async () => {
    const { app: a, invalidate } = await make({ markRead: async () => { throw new Error('boom'); } });
    expect((await post(a, { items: [{ account: 'moonray', threadId: 't' }] })).statusCode).toBe(502);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('says the mailbox is busy when Nylas rate-limits every write', async () => {
    const { app: a } = await make({ markRead: async () => { throw new MailboxRateLimitedError(5); } });
    const res = await post(a, { items: [{ account: 'moonray', threadId: 't' }] });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Mailbox busy');
  });

  it('503 when none of the mailboxes is connected; mixed batches fail only the unconnected ones', async () => {
    expect((await post((await make({ connected: [] })).app, { items: [{ account: 'moonray', threadId: 't' }] })).statusCode).toBe(503);
    await app?.close();
    const { app: a } = await make({ connected: ['moonray'] });
    const res = await post(a, { items: [{ account: 'moonray', threadId: 'a' }, { account: 'personal', threadId: 'b' }] });
    expect(res.json()).toMatchObject({ marked: 1, failed: 1, failedItems: [{ account: 'personal', threadId: 'b' }] });
  });
});
