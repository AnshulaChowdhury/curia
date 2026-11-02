import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneTriageRoutes } from '../../../../../src/channels/http/routes/phone-triage.js';
import type { UnsortedItem } from '../../../../../src/inbox-triage/item-store.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const AUTH = { authorization: 'Bearer secret' };
const ITEM: UnsortedItem = {
  accountId: 'moonray', messageId: 'm1', threadId: 't1', from: 'Dana\u0000 Lee', subject: 'Quarterly\nnumbers',
  snippet: 'Hi there', receivedAt: '2026-11-02T14:00:00.000Z', reason: 'none',
};

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function make(opts: { token?: string | null; item?: UnsortedItem | null; applyLabel?: () => Promise<void>; source?: 'none' } = {}) {
  const store = {
    listUnsorted: vi.fn(async () => [ITEM]),
    countUnsorted: vi.fn(async () => 1),
    getUnsorted: vi.fn(async () => (opts.item === undefined ? ITEM : opts.item)),
    resolve: vi.fn(async () => true),
  };
  const applyLabel = vi.fn(opts.applyLabel ?? (async () => {}));
  app = Fastify();
  await app.register(phoneTriageRoutes, {
    logger: createSilentLogger(),
    getToken: async () => (opts.token === undefined ? 'secret' : opts.token),
    store,
    getSource: async () => (opts.source === 'none' ? null : { applyLabel }),
  });
  return { app, store, applyLabel };
}

const post = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = AUTH) =>
  a.inject({ method: 'POST', url: '/phone/triage/review', headers, payload: payload as object });

describe('GET /phone/triage/review', () => {
  it('is invisible without a token and rejects a wrong one', async () => {
    expect((await (await make({ token: null })).app.inject({ method: 'GET', url: '/phone/triage/review', headers: AUTH })).statusCode).toBe(404);
    const { app: a } = await make();
    expect((await a.inject({ method: 'GET', url: '/phone/triage/review', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('returns one clean card per email with the six options, uncached', async () => {
    const { app: a } = await make();
    const res = await a.inject({ method: 'GET', url: '/phone/triage/review', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]).toMatchObject({ id: 'moonray:m1', account: 'moonray', messageId: 'm1', from: 'Dana Lee', subject: 'Quarterly numbers', reason: 'none' });
    expect(body.cards[0].options.map((o: { group: string }) => o.group)).toEqual(['urgent', 'drafted', 'seen', 'newsletter', 'spam', 'dismiss']);
    expect(body.cards[0].options[2].label).toBe('FYI, no action needed');
  });
});

describe('POST /phone/triage/review', () => {
  it('applies the chosen category, then marks the card resolved', async () => {
    const { app: a, store, applyLabel } = await make();
    const res = await post(a, { account: 'moonray', messageId: 'm1', group: 'drafted' });
    expect(res.statusCode).toBe(200);
    expect(applyLabel).toHaveBeenCalledWith('m1', 'drafted');
    expect(store.resolve).toHaveBeenCalledWith('moonray', 'm1', 'drafted');
    expect(res.json()).toMatchObject({ ok: true, id: 'moonray:m1', remaining: 1 });
  });

  it('"dismiss" resolves the card without touching the mailbox', async () => {
    const { app: a, store, applyLabel } = await make();
    expect((await post(a, { account: 'moonray', messageId: 'm1', group: 'dismiss' })).statusCode).toBe(200);
    expect(applyLabel).not.toHaveBeenCalled();
    expect(store.resolve).toHaveBeenCalledWith('moonray', 'm1', null);
  });

  it('rejects bad input, a missing token and an unknown group', async () => {
    const { app: a, store } = await make();
    expect((await post(a, { account: 'moonray', messageId: 'm1', group: 'none' })).statusCode).toBe(400);
    expect((await post(a, { account: 'moonray', group: 'seen' })).statusCode).toBe(400);
    expect((await post(a, { account: 'moonray', messageId: 'm1', group: 'seen' }, {})).statusCode).toBe(401);
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('404 when the email is not waiting, so a double tap labels nothing twice', async () => {
    const { app: a, applyLabel } = await make({ item: null });
    expect((await post(a, { account: 'moonray', messageId: 'm1', group: 'seen' })).statusCode).toBe(404);
    expect(applyLabel).not.toHaveBeenCalled();
  });

  it('keeps the card when the mailbox write fails (502) or is not connected (503)', async () => {
    const failing = await make({ applyLabel: async () => { throw new Error('Nylas PUT /messages responded 500'); } });
    expect((await post(failing.app, { account: 'moonray', messageId: 'm1', group: 'seen' })).statusCode).toBe(502);
    expect(failing.store.resolve).not.toHaveBeenCalled();
    await failing.app.close();
    const missing = await make({ source: 'none' });
    expect((await post(missing.app, { account: 'moonray', messageId: 'm1', group: 'seen' })).statusCode).toBe(503);
    expect(missing.store.resolve).not.toHaveBeenCalled();
  });
});
