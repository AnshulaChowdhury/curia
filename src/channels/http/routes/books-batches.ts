// books-batches.ts — the weekly books batch: pushed by the books agent, reviewed and approved by the owner, pulled back
// by the agent for posting to QuickBooks, with the results recorded per row.
//
//   POST  /books/batches                          — books token: store (or refresh) a batch
//   GET   /books/batches/approved                 — books token: approved rows waiting to be posted
//   POST  /books/batches/:id/results              — books token: what happened to each row
//   GET   /api/books/batches                      — signed-in owner: the batches
//   GET   /api/books/batches/:id                  — signed-in owner: one batch with its rows
//   PATCH /api/books/batches/:id/rows/:rowId      — signed-in owner: edit category, tax code, location, class, payee
//   POST  /api/books/batches/:id/decide           — signed-in owner: approve, skip or undo rows
//
// Row descriptions come from bank files and are untrusted: they are only ever returned as JSON and shown as text.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import { BatchError, validatePush, type BatchStore, type Decision } from '../../../books/batch-store.js';
import type { BooksToken } from '../../../quickbooks/books-token.js';
import { booksAuth } from '../books-auth.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface BooksBatchRouteOptions {
  logger: Logger;
  batchStore: BatchStore;
  booksToken: BooksToken;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

const BATCH_ID = /^[0-9a-f]{8,64}$/;
const MAX_BODY = 2 * 1024 * 1024 + 16 * 1024;

export async function booksBatchRoutes(app: FastifyInstance, options: BooksBatchRouteOptions): Promise<void> {
  const { logger, batchStore, booksToken, webAppBootstrapSecret, sessions } = options;
  const RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const BIG = { bodyLimit: MAX_BODY, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const authorised = booksAuth(booksToken, logger);

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BatchError) {
      const status = err.kind === 'not_found' ? 404 : err.kind === 'locked' ? 409 : 400;
      return reply.status(status).send({ error: err.message });
    }
    logger.error({ err }, 'books: batch call failed');
    return reply.status(500).send({ error: 'Internal error' });
  };
  const goodBatchId = (reply: FastifyReply, id: string): boolean => {
    if (BATCH_ID.test(id)) return true;
    void reply.status(400).send({ error: 'Bad batch id' });
    return false;
  };

  // -- the books agent -------------------------------------------------------------------------------------------

  app.post<{ Body: { batch?: { batch_id?: unknown; rows?: unknown }; report?: unknown } }>('/books/batches', BIG, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    try {
      const { batchId, rows, report } = validatePush(request.body?.batch?.batch_id, request.body?.batch?.rows, request.body?.report);
      const n = await batchStore.upsertBatch(batchId, report, rows);
      logger.info({ batchId, rows: n }, 'books: batch stored');
      return reply.header('Cache-Control', 'no-store').send({ ok: true, rows: n });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/books/batches/approved', RATE, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    try {
      return reply.header('Cache-Control', 'no-store').send({ batches: await batchStore.approvedForPosting() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { results?: unknown } }>('/books/batches/:id/results', BIG, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    if (!goodBatchId(reply, request.params.id)) return reply;
    try {
      const out = await batchStore.recordResults(request.params.id, request.body?.results);
      logger.info({ batchId: request.params.id, recorded: out.recorded, ignored: out.ignored.length }, 'books: posting results recorded');
      return reply.header('Cache-Control', 'no-store').send({ ok: true, ...out });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // -- the owner, signed in --------------------------------------------------------------------------------------

  app.get('/api/books/batches', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    try {
      return reply.header('Cache-Control', 'no-store').send({ batches: await batchStore.listBatches() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/books/batches/:id', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    if (!goodBatchId(reply, request.params.id)) return reply;
    try {
      return reply.header('Cache-Control', 'no-store').send(await batchStore.getBatch(request.params.id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string; rowId: string }; Body: { edits?: unknown } }>('/api/books/batches/:id/rows/:rowId', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    if (!goodBatchId(reply, request.params.id)) return reply;
    if (request.params.rowId.length > 100) return reply.status(400).send({ error: 'Bad row id' });
    try {
      const row = await batchStore.editRow(request.params.id, request.params.rowId, request.body?.edits);
      return reply.header('Cache-Control', 'no-store').send({ row });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { row_ids?: unknown; decision?: unknown } }>('/api/books/batches/:id/decide', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    if (!goodBatchId(reply, request.params.id)) return reply;
    const { row_ids: rowIds, decision } = request.body ?? {};
    if (!Array.isArray(rowIds) || !rowIds.every(r => typeof r === 'string' && r.length > 0 && r.length <= 100)) {
      return reply.status(400).send({ error: 'row_ids must be a list of row ids' });
    }
    if (decision !== 'approved' && decision !== 'skipped' && decision !== 'pending') {
      return reply.status(400).send({ error: 'decision must be approved, skipped or pending' });
    }
    try {
      const updated = await batchStore.decide(request.params.id, rowIds as string[], decision as Decision);
      logger.info({ batchId: request.params.id, decision, updated }, 'books: rows decided');
      return reply.header('Cache-Control', 'no-store').send({ ok: true, updated });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
