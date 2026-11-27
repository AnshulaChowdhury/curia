// budget-accounts.ts — assets, debts and net worth for the personal budget, owner only.
//
//   GET    /api/budget/accounts       — { accounts[], totals }: every asset and debt, and the sums
//   POST   /api/budget/accounts       — { name, type, balanceCents }: add one the owner keeps by hand
//   PUT    /api/budget/accounts/:id   — replace a hand-kept one
//   DELETE /api/budget/accounts/:id   — remove a hand-kept one
//
// Bank balances are refreshed by the bank sync routes and cannot be changed here. Nothing here is reachable by an agent.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { AccountStore } from '../../../budget/accounts-store.js';
import { BudgetError } from '../../../budget/budget-store.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

export interface BudgetAccountsRouteOptions {
  logger: Logger;
  accounts: Pick<AccountStore, 'summary' | 'createManual' | 'updateManual' | 'deleteManual'>;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

type Body = Record<string, unknown>;

export async function budgetAccountsRoutes(app: FastifyInstance, options: BudgetAccountsRouteOptions): Promise<void> {
  const { logger, accounts, webAppBootstrapSecret, sessions } = options;
  const RATE = { bodyLimit: 8 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const owner = (request: Parameters<typeof assertSecret>[0], reply: FastifyReply): boolean => assertSecret(request, reply, webAppBootstrapSecret, sessions);
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');
  const goodId = (reply: FastifyReply, id: string): boolean => {
    if (isUuid(id)) return true;
    void reply.status(400).send({ error: 'Bad id' });
    return false;
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BudgetError) return reply.status(err.kind === 'not_found' ? 404 : 400).send({ error: err.message });
    logger.error({ err }, 'budget: accounts call failed');
    return reply.status(500).send({ error: 'Internal error' });
  };

  app.get('/api/budget/accounts', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).send(await accounts.summary());
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: Body }>('/api/budget/accounts', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).status(201).send({ account: await accounts.createManual(request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: Body }>('/api/budget/accounts/:id', RATE, async (request, reply) => {
    if (!owner(request, reply) || !goodId(reply, request.params.id)) return reply;
    try {
      return noStore(reply).send({ account: await accounts.updateManual(request.params.id, request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/budget/accounts/:id', RATE, async (request, reply) => {
    if (!owner(request, reply) || !goodId(reply, request.params.id)) return reply;
    try {
      await accounts.deleteManual(request.params.id);
      return noStore(reply).send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
