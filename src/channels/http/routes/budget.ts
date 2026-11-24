// budget.ts — personal budgeting, owner only.
//
//   GET    /api/budget/categories                   — the categories with their monthly budgets
//   POST   /api/budget/categories                   — add one
//   PATCH  /api/budget/categories/:id               — rename, change the budget or rollover
//   DELETE /api/budget/categories/:id               — archive it; its transactions go back to uncategorised
//   GET    /api/budget/summary?month=YYYY-MM        — spent against budget per category, and what needs the owner
//   GET    /api/budget/transactions                 — filter by month, category, account, needsReview
//   PATCH  /api/budget/transactions/:id             — set or clear one transaction's category
//   POST   /api/budget/transactions/bulk-categorise — set or clear the category of up to 500 transactions
//   GET    /api/budget/rules, PUT /api/budget/rules — the categorisation rules, one YAML document
//
// Every route needs the signed-in owner (a failed check answers 401). Nothing here is reachable by an agent, and
// bank text (payee, description) is only ever returned as JSON strings.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import { BudgetError, type BudgetStore } from '../../../budget/budget-store.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

export interface BudgetRouteOptions {
  logger: Logger;
  store: Pick<BudgetStore, 'listCategories' | 'createCategory' | 'updateCategory' | 'deleteCategory' | 'summary' | 'listTransactions' | 'categorise' | 'getRules' | 'putRules'>;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

type Body = Record<string, unknown>;

export async function budgetRoutes(app: FastifyInstance, options: BudgetRouteOptions): Promise<void> {
  const { logger, store, webAppBootstrapSecret, sessions } = options;
  const RATE = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const RULES = { bodyLimit: 80 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const owner = (request: Parameters<typeof assertSecret>[0], reply: FastifyReply): boolean => assertSecret(request, reply, webAppBootstrapSecret, sessions);

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BudgetError) {
      return reply.status(err.kind === 'not_found' ? 404 : err.kind === 'conflict' ? 409 : 400).send({ error: err.message });
    }
    logger.error({ err }, 'budget: call failed');
    return reply.status(500).send({ error: 'Internal error' });
  };
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');
  const goodId = (reply: FastifyReply, id: string): boolean => {
    if (isUuid(id)) return true;
    void reply.status(400).send({ error: 'Bad id' });
    return false;
  };

  app.get('/api/budget/categories', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).send({ categories: await store.listCategories() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: Body }>('/api/budget/categories', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).status(201).send({ category: await store.createCategory(request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Body }>('/api/budget/categories/:id', RATE, async (request, reply) => {
    if (!owner(request, reply) || !goodId(reply, request.params.id)) return reply;
    try {
      return noStore(reply).send({ category: await store.updateCategory(request.params.id, request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/budget/categories/:id', RATE, async (request, reply) => {
    if (!owner(request, reply) || !goodId(reply, request.params.id)) return reply;
    try {
      await store.deleteCategory(request.params.id);
      return noStore(reply).send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: { month?: string } }>('/api/budget/summary', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      const month = request.query.month ?? new Date().toISOString().slice(0, 7);
      return noStore(reply).send(await store.summary(month));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: { month?: string; categoryId?: string; account?: string; needsReview?: string; limit?: string } }>(
    '/api/budget/transactions', RATE, async (request, reply) => {
      if (!owner(request, reply)) return reply;
      const q = request.query;
      if (q.categoryId !== undefined && !goodId(reply, q.categoryId)) return reply;
      try {
        const limit = q.limit === undefined ? undefined : Number(q.limit);
        return noStore(reply).send({
          transactions: await store.listTransactions({
            month: q.month, categoryId: q.categoryId, account: q.account?.slice(0, 60),
            needsReview: q.needsReview === 'true', limit: Number.isFinite(limit) ? limit : undefined,
          }),
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  const categoryIdOf = (body: Body | undefined): string | null | undefined =>
    body?.['categoryId'] === null ? null : typeof body?.['categoryId'] === 'string' && isUuid(body['categoryId']) ? body['categoryId'] : undefined;

  app.patch<{ Params: { id: string }; Body: Body }>('/api/budget/transactions/:id', RATE, async (request, reply) => {
    if (!owner(request, reply) || !goodId(reply, request.params.id)) return reply;
    const categoryId = categoryIdOf(request.body);
    if (categoryId === undefined) return reply.status(400).send({ error: 'categoryId must be a category id, or null to clear it' });
    try {
      return noStore(reply).send({ ok: true, updated: await store.categorise([request.params.id], categoryId) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: Body }>('/api/budget/transactions/bulk-categorise', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const ids = request.body?.['ids'];
    const categoryId = categoryIdOf(request.body);
    if (!Array.isArray(ids) || !ids.every(i => typeof i === 'string' && isUuid(i))) return reply.status(400).send({ error: 'ids must be a list of transaction ids' });
    if (categoryId === undefined) return reply.status(400).send({ error: 'categoryId must be a category id, or null to clear it' });
    try {
      return noStore(reply).send({ ok: true, updated: await store.categorise(ids as string[], categoryId) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/budget/rules', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).send(await store.getRules());
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Body: Body }>('/api/budget/rules', RULES, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).send({ ok: true, ...(await store.putRules(request.body?.['yaml'])) });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
