import { describe, expect, it, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneMailboxCategoryRoutes } from '../../../../../src/channels/http/routes/phone-mailbox-category.js';
import { InMemoryMailboxCategoryStore } from '../../../../../src/phone-inbox/mailbox-category-store.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const AUTH = { authorization: 'Bearer secret' };
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function make(opts: { token?: string | null; store?: InMemoryMailboxCategoryStore } = {}) {
  const store = opts.store ?? new InMemoryMailboxCategoryStore();
  const logger = { ...createSilentLogger(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReturnType<typeof createSilentLogger>;
  app = Fastify();
  await app.register(phoneMailboxCategoryRoutes, {
    logger,
    getToken: async () => (opts.token === undefined ? 'secret' : opts.token),
    store,
  });
  return { app, store, logger };
}

const put = (a: FastifyInstance, id: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  a.inject({ method: 'PUT', url: `/phone/inbox/accounts/${id}/category`, headers, payload: payload as object });

describe('PUT /phone/inbox/accounts/:accountId/category', () => {
  it('is invisible without a token and rejects a missing or wrong one', async () => {
    expect((await put((await make({ token: null })).app, 'moonray', { category: 'WORK' })).statusCode).toBe(404);
    const { app: a, store } = await make();
    expect((await put(a, 'moonray', { category: 'WORK' }, {})).statusCode).toBe(401);
    expect((await put(a, 'moonray', { category: 'WORK' }, { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect(await store.list()).toEqual([]);
  });

  it('stores the category and answers 204 with no body', async () => {
    const { app: a, store } = await make();
    const res = await put(a, 'moonray', { category: 'WORK' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await store.get('moonray')).toMatchObject({ accountId: 'moonray', category: 'WORK' });
  });

  it('accepts all three account ids', async () => {
    const { app: a, store } = await make();
    for (const id of ['personal', 'moonray', 'work-outlook']) expect((await put(a, id, { category: 'PERSONAL' })).statusCode).toBe(204);
    expect((await store.list()).map((r) => r.accountId).sort()).toEqual(['moonray', 'personal', 'work-outlook']);
  });

  it('answers 404 for an unknown account and stores nothing', async () => {
    const { app: a, store } = await make();
    expect((await put(a, 'someone-else', { category: 'WORK' })).statusCode).toBe(404);
    expect(await store.list()).toEqual([]);
  });

  it.each([
    ['lower case', { category: 'work' }],
    ['both', { category: 'BOTH' }],
    ['missing', {}],
    ['not a string', { category: 1 }],
    ['an extra field (an address must never ride along)', { category: 'WORK', address: 'a@b.example' }],
  ])('answers 400 for a bad body (%s) and stores nothing', async (_name, payload) => {
    const { app: a, store } = await make();
    expect((await put(a, 'personal', payload)).statusCode).toBe(400);
    expect(await store.list()).toEqual([]);
  });

  it('is idempotent: the same value twice keeps one row, and only a change is logged', async () => {
    const { app: a, store, logger } = await make();
    await put(a, 'personal', { category: 'PERSONAL' });
    await put(a, 'personal', { category: 'PERSONAL' });
    expect(await store.list()).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    await put(a, 'personal', { category: 'WORK' });
    expect((await store.get('personal'))?.category).toBe('WORK');
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('logs the account id and category only: no token, no address', async () => {
    const { app: a, logger } = await make();
    await put(a, 'moonray', { category: 'WORK' });
    const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain('moonray');
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('@');
  });

  it('answers 500 when the store fails, without leaking the error', async () => {
    const store = new InMemoryMailboxCategoryStore();
    vi.spyOn(store, 'report').mockRejectedValue(new Error('db down: password=hunter2'));
    const { app: a } = await make({ store });
    const res = await put(a, 'personal', { category: 'WORK' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
  });
});
