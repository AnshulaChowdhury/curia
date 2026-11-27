import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { budgetSheetsRoutes } from '../../../../src/channels/http/routes/budget-sheets.js';
import { BudgetError } from '../../../../src/budget/budget-store.js';
import type { Logger } from '../../../../src/logger.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const SECRET = 'a-long-bootstrap-secret-for-tests-0123456789';
const auth = { 'x-web-bootstrap-secret': SECRET };
const ID = '11111111-1111-4111-8111-111111111111';

async function app(over: Record<string, unknown> = {}) {
  const sheets = {
    list: vi.fn(async () => []), create: vi.fn(async () => ({ id: ID, version: 1 })), get: vi.fn(async () => ({ id: ID })),
    save: vi.fn(async () => ({ id: ID, version: 2 })), remove: vi.fn(async () => undefined),
    attachedInfo: vi.fn(async () => null), detach: vi.fn(async () => undefined), ...over,
  };
  const a = Fastify();
  await a.register(budgetSheetsRoutes, { logger, sheets: sheets as never, webAppBootstrapSecret: SECRET, sessions: new Map() as SessionStore });
  return { a, sheets };
}

describe('/api/budget/sheets', () => {
  it('refuses every route without the owner, before touching the store, even with a bad body', async () => {
    const { a, sheets } = await app();
    for (const [method, url] of [['GET', '/api/budget/sheets'], ['POST', '/api/budget/sheets'], ['GET', `/api/budget/sheets/${ID}`], ['PUT', `/api/budget/sheets/${ID}`], ['DELETE', `/api/budget/sheets/${ID}`], ['GET', '/api/budget/sheets/attached?conversationId=c1'], ['DELETE', '/api/budget/sheets/attached?conversationId=c1']] as const) {
      expect((await a.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: '{not json' })).statusCode, `${method} ${url}`).toBe(401);
    }
    for (const fn of Object.values(sheets)) expect(fn).not.toHaveBeenCalled();
  });

  it('creates, saves with a version, and reports a conflict as 409', async () => {
    const { a, sheets } = await app();
    expect((await a.inject({ method: 'POST', url: '/api/budget/sheets', headers: auth, payload: { name: 'x', workbook: {} } })).statusCode).toBe(201);
    const res = await a.inject({ method: 'PUT', url: `/api/budget/sheets/${ID}`, headers: auth, payload: { version: 1, workbook: { a: 1 } } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(sheets.save).toHaveBeenCalledWith(ID, 1, { a: 1 });
    const late = await app({ save: vi.fn(async () => { throw new BudgetError('changed', 'conflict'); }) });
    expect((await late.a.inject({ method: 'PUT', url: `/api/budget/sheets/${ID}`, headers: auth, payload: { version: 1 } })).statusCode).toBe(409);
  });

  it('looks up and detaches the sheet attached to a chat', async () => {
    const { a, sheets } = await app();
    const got = await a.inject({ method: 'GET', url: '/api/budget/sheets/attached?conversationId=c1', headers: auth });
    expect(got.json()).toEqual({ sheet: null });
    expect(sheets.attachedInfo).toHaveBeenCalledWith('c1');
    expect((await a.inject({ method: 'DELETE', url: '/api/budget/sheets/attached?conversationId=c1', headers: auth })).statusCode).toBe(200);
    expect(sheets.detach).toHaveBeenCalledWith('c1');
    expect(sheets.get).not.toHaveBeenCalled();
    expect(sheets.remove).not.toHaveBeenCalled();
  });

  it('takes a workbook larger than the server default, but not an unbounded one, and checks ids', async () => {
    const { a } = await app();
    const big = (bytes: number) => a.inject({ method: 'POST', url: '/api/budget/sheets', headers: auth, payload: { name: 'x', workbook: 'x'.repeat(bytes) } });
    expect((await big(2 * 1024 * 1024)).statusCode).toBe(201);
    expect((await big(6 * 1024 * 1024)).statusCode).toBe(413);
    expect((await a.inject({ method: 'GET', url: '/api/budget/sheets/nope', headers: auth })).statusCode).toBe(400);
  });
});
