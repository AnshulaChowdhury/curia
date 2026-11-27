// budget-sheets.ts — the budget spreadsheets, owner only.
//
//   GET    /api/budget/sheets       — the stored sheets (no cell data)
//   POST   /api/budget/sheets       — { name, workbook }: store a new one
//   GET    /api/budget/sheets/:id   — one sheet with its workbook
//   PUT    /api/budget/sheets/:id   — { version, workbook }: save over the version loaded (409 if it moved on)
//   DELETE /api/budget/sheets/:id   — remove it
//
// Every workbook is cleaned before it is stored (see budget/sheet-snapshot.ts). Nothing here is reachable by an agent.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import { BudgetError } from '../../../budget/budget-store.js';
import type { SheetStore } from '../../../budget/sheet-store.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

export interface BudgetSheetsRouteOptions {
  logger: Logger;
  sheets: Pick<SheetStore, 'list' | 'create' | 'get' | 'save' | 'remove'>;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

type Body = Record<string, unknown>;

export async function budgetSheetsRoutes(app: FastifyInstance, options: BudgetSheetsRouteOptions): Promise<void> {
  const { logger, sheets, webAppBootstrapSecret, sessions } = options;
  const READ = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  // The grid saves as the owner types, so writes get the same allowance; the body is a whole workbook.
  const WRITE = { bodyLimit: 5 * 1024 * 1024, ...READ };
  const owner = (request: Parameters<typeof assertSecret>[0], reply: FastifyReply): boolean => assertSecret(request, reply, webAppBootstrapSecret, sessions);
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');
  const goodId = (reply: FastifyReply, id: string): boolean => {
    if (isUuid(id)) return true;
    void reply.status(400).send({ error: 'Bad id' });
    return false;
  };
  // Every route checks the owner before the request body is read: a workbook body can be several megabytes.
  const early = { onRequest: async (request: Parameters<typeof assertSecret>[0], reply: FastifyReply) => (owner(request, reply) ? undefined : reply) };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BudgetError) return reply.status(err.kind === 'not_found' ? 404 : err.kind === 'conflict' ? 409 : 400).send({ error: err.message });
    logger.error({ err }, 'budget: sheet call failed');
    return reply.status(500).send({ error: 'Internal error' });
  };

  app.get('/api/budget/sheets', { ...READ, ...early }, async (_request, reply) => {
    try {
      return noStore(reply).send({ sheets: await sheets.list() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: Body }>('/api/budget/sheets', { ...WRITE, ...early }, async (request, reply) => {
    try {
      return noStore(reply).status(201).send({ sheet: await sheets.create(request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/budget/sheets/:id', { ...READ, ...early }, async (request, reply) => {
    if (!goodId(reply, request.params.id)) return reply;
    try {
      return noStore(reply).send({ sheet: await sheets.get(request.params.id) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: Body }>('/api/budget/sheets/:id', { ...WRITE, ...early }, async (request, reply) => {
    if (!goodId(reply, request.params.id)) return reply;
    try {
      return noStore(reply).send({ sheet: await sheets.save(request.params.id, request.body?.['version'], request.body?.['workbook']) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/budget/sheets/:id', { ...READ, ...early }, async (request, reply) => {
    if (!goodId(reply, request.params.id)) return reply;
    try {
      await sheets.remove(request.params.id);
      return noStore(reply).send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
