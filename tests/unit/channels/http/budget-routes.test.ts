import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { budgetRoutes } from '../../../../src/channels/http/routes/budget.js';
import { BudgetError } from '../../../../src/budget/budget-store.js';
import type { Logger } from '../../../../src/logger.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const SECRET = 'a-long-bootstrap-secret-for-tests-0123456789';
const auth = { 'x-web-bootstrap-secret': SECRET };
const ID = '11111111-1111-4111-8111-111111111111';

async function app(over: Record<string, unknown> = {}, projector?: { through: (last: string) => Promise<unknown> }) {
  const store = {
    listCategories: vi.fn(async () => []), createCategory: vi.fn(async () => ({ id: ID })), updateCategory: vi.fn(async () => ({ id: ID })),
    deleteCategory: vi.fn(async () => undefined), setMonthAmount: vi.fn(async () => undefined), setMonthAmounts: vi.fn(async () => undefined), planAll: vi.fn(async () => ({ months: ['2031-03', '2031-04'], categories: [], truncated: false })), plan: vi.fn(async (from: string, months?: number) => ({ from, months })), archiveCategory: vi.fn(async () => ({ id: ID })), trend: vi.fn(async (asOf: string) => ({ asOf })), summary: vi.fn(async (month: string) => ({ month })), listTransactions: vi.fn(async () => []),
    categorise: vi.fn(async () => 1), getRules: vi.fn(async () => ({ yaml: '', updatedAt: null })), putRules: vi.fn(async () => ({ updatedAt: 'x' })), addTransactions: vi.fn(async (items: unknown[]) => ({ added: items.length, duplicates: 0 })), ...over,
  };
  const a = Fastify();
  await a.register(budgetRoutes, { logger, store: store as never, projector: projector as never, webAppBootstrapSecret: SECRET, sessions: { verify: () => null } as unknown as SessionStore });
  return { a, store };
}

describe('/api/budget', () => {
  it('refuses every route without the owner session, before touching the store', async () => {
    const { a, store } = await app();
    for (const [method, url] of [
      ['GET', '/api/budget/categories'], ['POST', '/api/budget/categories'], ['PATCH', `/api/budget/categories/${ID}`],
      ['DELETE', `/api/budget/categories/${ID}`], ['POST', `/api/budget/categories/${ID}/archive`], ['GET', '/api/budget/summary'], ['GET', '/api/budget/trend'], ['GET', '/api/budget/transactions'],
      ['PATCH', `/api/budget/transactions/${ID}`], ['POST', '/api/budget/transactions/bulk-categorise'],
      ['GET', '/api/budget/rules'], ['PUT', '/api/budget/rules'], ['POST', '/api/budget/imports'],
      ['GET', '/api/budget/plan'], ['GET', '/api/budget/plan?all=1'], ['PUT', `/api/budget/categories/${ID}/months/2031-03`], ['PUT', `/api/budget/categories/${ID}/months`],
    ] as const) {
      expect((await a.inject({ method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(401);
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it('lists archived categories only when asked, archives one, and answers 409 for a delete that must be an archive', async () => {
    const { a, store } = await app({ deleteCategory: vi.fn(async () => { throw new BudgetError('This category has transactions. Archive it instead.', 'conflict'); }) });
    await a.inject({ method: 'GET', url: '/api/budget/categories', headers: auth });
    expect(store.listCategories).toHaveBeenLastCalledWith({ includeArchived: false });
    await a.inject({ method: 'GET', url: '/api/budget/categories?archived=1', headers: auth });
    expect(store.listCategories).toHaveBeenLastCalledWith({ includeArchived: true });
    expect((await a.inject({ method: 'POST', url: `/api/budget/categories/${ID}/archive`, headers: auth })).statusCode).toBe(200);
    expect(store.archiveCategory).toHaveBeenCalledWith(ID);
    expect((await a.inject({ method: 'DELETE', url: `/api/budget/categories/${ID}`, headers: auth })).statusCode).toBe(409);
  });

  it('reads the plan and sets one month, refusing a request with no amount', async () => {
    const { a, store } = await app();
    expect((await a.inject({ method: 'GET', url: '/api/budget/plan?from=2031-03&months=6', headers: auth })).json()).toEqual({ from: '2031-03', months: 6 });
    const url = `/api/budget/categories/${ID}/months/2031-04`;
    expect((await a.inject({ method: 'PUT', url, headers: auth, payload: {} })).statusCode).toBe(400);
    expect(store.setMonthAmount).not.toHaveBeenCalled();
    expect((await a.inject({ method: 'PUT', url, headers: auth, payload: { cents: null } })).statusCode).toBe(200);
    expect(store.setMonthAmount).toHaveBeenCalledWith(ID, '2031-04', null);
  });

  it('returns the whole budget with net worth through its last month, and without it when that fails', async () => {
    const through = vi.fn(async (last: string) => ({ upTo: last }));
    const { a, store } = await app({}, { through });
    const res = await a.inject({ method: 'GET', url: '/api/budget/plan?all=1&from=2031-03&through=2031-04', headers: auth });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ months: ['2031-03', '2031-04'], truncated: false, projection: { upTo: '2031-04' } });
    expect(store.planAll).toHaveBeenCalledWith('2031-03', '2031-04');
    expect(store.plan).not.toHaveBeenCalled();

    const broken = await app({}, { through: async () => { throw new Error('no balances'); } });
    const still = await broken.a.inject({ method: 'GET', url: '/api/budget/plan?all=1&from=2031-03', headers: auth });
    expect(still.statusCode).toBe(200);
    expect(still.json()).toMatchObject({ months: ['2031-03', '2031-04'], projection: null });
  });

  it('sets several months at once, refusing a request with no amount', async () => {
    const { a, store } = await app();
    const url = `/api/budget/categories/${ID}/months`;
    expect((await a.inject({ method: 'PUT', url, headers: auth, payload: { months: ['2031-04'] } })).statusCode).toBe(400);
    expect(store.setMonthAmounts).not.toHaveBeenCalled();
    expect((await a.inject({ method: 'PUT', url, headers: auth, payload: { months: ['2031-04', '2031-05'], cents: 5 } })).statusCode).toBe(200);
    expect(store.setMonthAmounts).toHaveBeenCalledWith(ID, ['2031-04', '2031-05'], 5);
  });

  it('returns the history as of the date asked', async () => {
    const { a, store } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/budget/trend?asOf=2031-03-15', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(store.trend).toHaveBeenCalledWith('2031-03-15');
  });

  it('returns the server-computed summary for the month asked', async () => {
    const { a, store } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/budget/summary?month=2026-11', headers: auth });
    expect(res.json()).toEqual({ month: '2026-11' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(store.summary).toHaveBeenCalledWith('2026-11');
  });

  it('maps store errors to 400, 404 and 409, and hides anything else', async () => {
    const status = async (err: unknown) => {
      const { a } = await app({ createCategory: vi.fn(async () => { throw err; }) });
      return a.inject({ method: 'POST', url: '/api/budget/categories', headers: auth, payload: { name: 'x' } });
    };
    expect((await status(new BudgetError('bad'))).statusCode).toBe(400);
    expect((await status(new BudgetError('gone', 'not_found'))).statusCode).toBe(404);
    expect((await status(new BudgetError('dup', 'conflict'))).statusCode).toBe(409);
    const hidden = await status(new Error('db password=hunter2'));
    expect(hidden.statusCode).toBe(500);
    expect(hidden.body).not.toContain('hunter2');
  });

  it('validates ids and the categoryId before categorising', async () => {
    const { a, store } = await app();
    expect((await a.inject({ method: 'PATCH', url: '/api/budget/transactions/not-an-id', headers: auth, payload: { categoryId: null } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PATCH', url: `/api/budget/transactions/${ID}`, headers: auth, payload: { categoryId: 'nope' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/budget/transactions/bulk-categorise', headers: auth, payload: { ids: ['x'], categoryId: null } })).statusCode).toBe(400);
    expect(store.categorise).not.toHaveBeenCalled();
    expect((await a.inject({ method: 'PATCH', url: `/api/budget/transactions/${ID}`, headers: auth, payload: { categoryId: null } })).statusCode).toBe(200);
    expect(store.categorise).toHaveBeenCalledWith([ID], null);
  });

  it('imports a bank file sent as the raw body', async () => {
    const { a, store } = await app();
    const csv = 'Transaction date,Transaction,Name,Memo,Amount\n3/9/2031,D,Invented Cafe,,-4.50\n';
    const res = await a.inject({ method: 'POST', url: '/api/budget/imports?name=t.csv&account=Tangerine', headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: Buffer.from(csv) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, format: 'tangerine-csv', added: 1, duplicates: 0, skipped: 0 });
    expect(store.addTransactions).toHaveBeenCalledOnce();
  });

  it('rejects a file that is not a bank file, or has no account, without touching the store', async () => {
    const { a, store } = await app();
    const h = { ...auth, 'content-type': 'application/octet-stream' };
    expect((await a.inject({ method: 'POST', url: '/api/budget/imports?name=x.exe&account=A', headers: h, payload: Buffer.from('MZ') })).statusCode).toBe(400);
    const csv = Buffer.from('Transaction date,Transaction,Name,Memo,Amount\n3/9/2031,D,N,,-1\n');
    expect((await a.inject({ method: 'POST', url: '/api/budget/imports?name=t.csv', headers: h, payload: csv })).statusCode).toBe(400);
    expect(store.addTransactions).not.toHaveBeenCalled();
  });
});
