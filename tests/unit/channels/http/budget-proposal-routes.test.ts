import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { budgetProposalRoutes } from '../../../../src/channels/http/routes/budget-proposals.js';
import { BudgetError } from '../../../../src/budget/budget-store.js';
import type { Logger } from '../../../../src/logger.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const SECRET = 'a-long-bootstrap-secret-for-tests-0123456789';
const auth = { 'x-web-bootstrap-secret': SECRET };
const ID = '11111111-1111-4111-8111-111111111111';

async function app(over: Record<string, unknown> = {}) {
  const proposals = { pending: vi.fn(async () => null), apply: vi.fn(async () => ({ created: 1, updated: 0, archived: 0 })), discard: vi.fn(async () => undefined), ...over };
  const a = Fastify();
  await a.register(budgetProposalRoutes, { logger, proposals: proposals as never, webAppBootstrapSecret: SECRET, sessions: { verify: () => null } as unknown as SessionStore });
  return { a, proposals };
}

describe('/api/budget/proposals', () => {
  it('refuses every route without the owner session, before touching the store', async () => {
    const { a, proposals } = await app();
    for (const [method, url] of [['GET', '/api/budget/proposals?conversationId=c'], ['POST', `/api/budget/proposals/${ID}/apply`], ['POST', `/api/budget/proposals/${ID}/discard`]] as const) {
      expect((await a.inject({ method, url, payload: { conversationId: 'c' } })).statusCode, url).toBe(401);
    }
    for (const fn of Object.values(proposals)) expect(fn).not.toHaveBeenCalled();
  });

  it('shows, applies and discards for the chat named, and needs one named', async () => {
    const { a, proposals } = await app();
    expect((await a.inject({ method: 'GET', url: '/api/budget/proposals?conversationId=chat-1', headers: auth })).json()).toEqual({ proposal: null });
    expect((await a.inject({ method: 'GET', url: '/api/budget/proposals', headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: `/api/budget/proposals/${ID}/apply`, headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: `/api/budget/proposals/${ID}/apply`, headers: auth, payload: { conversationId: 'chat-1' } })).json()).toEqual({ ok: true, created: 1, updated: 0, archived: 0 });
    expect(proposals.apply).toHaveBeenCalledWith(ID, 'chat-1');
    await a.inject({ method: 'POST', url: `/api/budget/proposals/${ID}/discard`, headers: auth, payload: { conversationId: 'chat-1' } });
    expect(proposals.discard).toHaveBeenCalledWith(ID, 'chat-1');
  });

  it('answers 409 with the reason when nothing was applied', async () => {
    const { a } = await app({ apply: vi.fn(async () => { throw new BudgetError('That proposal is no longer waiting', 'conflict'); }) });
    const res = await a.inject({ method: 'POST', url: `/api/budget/proposals/${ID}/apply`, headers: auth, payload: { conversationId: 'c' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'That proposal is no longer waiting' });
  });
});
