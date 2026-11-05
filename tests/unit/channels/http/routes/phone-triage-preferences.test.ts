import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneTriagePreferenceRoutes } from '../../../../../src/channels/http/routes/phone-triage-preferences.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const AUTH = { authorization: 'Bearer secret' };
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function make(opts: { token?: string | null; removed?: boolean } = {}) {
  const store = {
    save: vi.fn(async () => {}),
    list: vi.fn(async () => [
      { accountId: 'moonray' as const, scope: 'sender' as const, value: 'a@acme.com', group: 'drafted' as const, keywords: [] },
      { accountId: 'moonray' as const, scope: 'sender-keywords' as const, value: 'b@acme.com', group: 'urgent' as const, keywords: ['invoice'] },
    ]),
    remove: vi.fn(async () => opts.removed ?? true),
  };
  app = Fastify();
  await app.register(phoneTriagePreferenceRoutes, { logger: createSilentLogger(), getToken: async () => (opts.token === undefined ? 'secret' : opts.token), store });
  return { app, store };
}
const post = (a: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  a.inject({ method: 'POST', url, headers, payload: payload as object });

describe('/phone/triage/preferences', () => {
  it('is invisible without a token and rejects a wrong one without writing', async () => {
    expect((await post((await make({ token: null })).app, '/phone/triage/preferences', {})).statusCode).toBe(404);
    const { app: a, store } = await make();
    expect((await post(a, '/phone/triage/preferences', {}, { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('saves a sender or a domain, lower-cased', async () => {
    const { app: a, store } = await make();
    expect((await post(a, '/phone/triage/preferences', { account: 'moonray', scope: 'sender', value: 'Dana@Acme.com', group: 'drafted' })).statusCode).toBe(200);
    expect(store.save).toHaveBeenCalledWith({ accountId: 'moonray', scope: 'sender', value: 'dana@acme.com', group: 'drafted', keywords: [] });
    await post(a, '/phone/triage/preferences', { account: 'personal', scope: 'domain', value: 'acme.com', group: 'newsletter' });
    expect(store.save).toHaveBeenLastCalledWith({ accountId: 'personal', scope: 'domain', value: 'acme.com', group: 'newsletter', keywords: [] });
  });

  it.each([
    { account: 'nope', scope: 'sender', value: 'a@acme.com', group: 'seen' },
    { account: 'moonray', scope: 'everyone', value: 'a@acme.com', group: 'seen' },
    { account: 'moonray', scope: 'domain', value: 'gmail.com', group: 'seen' },
    { account: 'moonray', scope: 'sender', value: 'acme.com', group: 'seen' },
    { account: 'moonray', scope: 'sender', value: 'a@acme.com', group: 'dismiss' },
    { account: 'moonray', scope: 'sender', value: 'a@acme.com' },
  ])('rejects %j', async (payload) => {
    const { app: a, store } = await make();
    expect((await post(a, '/phone/triage/preferences', payload)).statusCode).toBe(400);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('lists what is saved, uncached', async () => {
    const { app: a } = await make();
    const res = await a.inject({ method: 'GET', url: '/phone/triage/preferences', headers: AUTH });
    expect(res.json()).toEqual({ preferences: [
      { account: 'moonray', scope: 'sender', value: 'a@acme.com', group: 'drafted' },
      { account: 'moonray', scope: 'sender-keywords', value: 'b@acme.com', group: 'urgent', keywords: ['invoice'] },
    ] });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('forgets one: 204, or 404 when it was not saved', async () => {
    const body = { account: 'moonray', scope: 'sender', value: 'a@acme.com' };
    const { app: a, store } = await make();
    expect((await post(a, '/phone/triage/preferences/forget', body)).statusCode).toBe(204);
    expect(store.remove).toHaveBeenCalledWith('moonray', 'sender', 'a@acme.com', []);
    await a.close();
    const missing = await make({ removed: false });
    expect((await post(missing.app, '/phone/triage/preferences/forget', body)).statusCode).toBe(404);
  });

  it('saves a keyword rule with its words sorted and lower-cased, and forgets it by the same words', async () => {
    const { app: a, store } = await make();
    const rule = { account: 'moonray', scope: 'sender-keywords', value: 'Billing@Acme.com', group: 'urgent', keywords: ['Overdue', 'invoice'] };
    expect((await post(a, '/phone/triage/preferences', rule)).statusCode).toBe(200);
    expect(store.save).toHaveBeenCalledWith({ accountId: 'moonray', scope: 'sender-keywords', value: 'billing@acme.com', group: 'urgent', keywords: ['invoice', 'overdue'] });
    expect((await post(a, '/phone/triage/preferences/forget', { account: 'moonray', scope: 'sender-keywords', value: 'billing@acme.com', keywords: ['overdue', 'invoice'] })).statusCode).toBe(204);
    expect(store.remove).toHaveBeenCalledWith('moonray', 'sender-keywords', 'billing@acme.com', ['invoice', 'overdue']);
  });

  it.each([
    { keywords: undefined }, { keywords: [] }, { keywords: ['one', 'two', 'three', 'four', 'five', 'sixes'] },
    { keywords: ['bad word'] }, { keywords: ['x1y2z3'] }, { keywords: ['ab'] }, { keywords: ['x'.repeat(41)] }, { keywords: 'invoice' },
  ])('rejects a keyword rule with %j', async (extra) => {
    const { app: a, store } = await make();
    const res = await post(a, '/phone/triage/preferences', { account: 'moonray', scope: 'sender-keywords', value: 'billing@acme.com', group: 'urgent', ...extra });
    expect(res.statusCode).toBe(400);
    expect(store.save).not.toHaveBeenCalled();
  });
});
