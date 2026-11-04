// books-run.ts — start a books run from Curia.
//
//   POST /api/books/run  — signed-in person: run now (waiting files -> a batch to review); the answer says what happened
//   GET  /api/books/run  — signed-in person: whether the books service is set up
//
// The run also happens by itself every few minutes when files are waiting; this is the "Run now" button on the Books page.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { BooksRunner } from '../../../books/books-runner.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface BooksRunRouteOptions {
  logger: Logger;
  /** Null when BOOKS_SERVICE_URL / BOOKS_SERVICE_TOKEN are not set. */
  runner: BooksRunner | null;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

export async function booksRunRoutes(app: FastifyInstance, options: BooksRunRouteOptions): Promise<void> {
  const { logger, runner, webAppBootstrapSecret, sessions } = options;

  app.get('/api/books/run', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send({ available: runner !== null });
  });

  app.post('/api/books/run', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    if (!runner) return reply.status(503).send({ error: 'The books service is not set up on this server' });
    try {
      return reply.header('Cache-Control', 'no-store').send(await runner.runOnce('manual'));
    } catch (err) {
      logger.error({ err }, 'books: run now failed');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
