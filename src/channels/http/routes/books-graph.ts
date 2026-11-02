// books-graph.ts — the accounting rules graph for the Knowledge Graph page.
//
//   POST /books/graph   — books token: the Mac mini pushes a read-only snapshot (rules, accounts, tax codes,
//                         locations, classes, payees; never transactions). Only the latest is kept.
//   GET  /api/books/graph — signed-in person: the stored snapshot and when it arrived, or {empty:true}.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { BooksToken } from '../../../quickbooks/books-token.js';
import { GraphError, MAX_SNAPSHOT_BYTES, validateSnapshot, type GraphSnapshotStore } from '../../../books/graph-store.js';
import { booksAuth } from '../books-auth.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface BooksGraphRouteOptions {
  logger: Logger;
  graphStore: Pick<GraphSnapshotStore, 'replace' | 'latest'>;
  booksToken: BooksToken;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

export async function booksGraphRoutes(app: FastifyInstance, options: BooksGraphRouteOptions): Promise<void> {
  const { logger, graphStore, booksToken, webAppBootstrapSecret, sessions } = options;
  const authorised = booksAuth(booksToken, logger);

  app.post<{ Body: { snapshot?: unknown } }>(
    '/books/graph',
    // The nodes and edges are bounded by validateSnapshot; the body limit is a coarser first guard.
    { bodyLimit: MAX_SNAPSHOT_BYTES + 4096, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!(await authorised(request, reply))) return reply;
      try {
        const snapshot = validateSnapshot(request.body?.snapshot);
        await graphStore.replace(snapshot);
        logger.info({ nodes: snapshot.nodes.length, edges: snapshot.edges.length }, 'books: accounting graph snapshot received');
        return reply.header('Cache-Control', 'no-store').send({ ok: true, nodes: snapshot.nodes.length, edges: snapshot.edges.length });
      } catch (err) {
        if (err instanceof GraphError) return reply.status(400).send({ error: err.message });
        logger.error({ err }, 'books: storing the graph snapshot failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  app.get('/api/books/graph', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    try {
      const stored = await graphStore.latest();
      return reply.header('Cache-Control', 'no-store').send(stored ?? { empty: true });
    } catch (err) {
      logger.error({ err }, 'books: reading the graph snapshot failed');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
