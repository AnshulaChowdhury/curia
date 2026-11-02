// books-monitor.ts — the Mac mini's check-ins and run reports, and the owner's view of them.
//
//   POST /books/heartbeat        — books token: the Mac mini is alive (every 15 minutes)
//   POST /books/runs             — books token: one run report; a failed one notifies the reviewers at once
//   GET  /api/books/status       — signed-in person: heartbeat age, last run, this week's accounts received/missing
//   GET  /api/books/reviewers    — signed-in person: who is notified
//   PUT  /api/books/reviewers    — signed-in person: replace the list (name, email, ntfy topic)
//
// Reports are untrusted JSON from the agent: size-capped, stored as data, never rendered as HTML.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { BooksMonitor } from '../../../books/monitor.js';
import { RUN_STATUSES, type MonitorStore, type RunStatus } from '../../../books/monitor-store.js';
import { ReviewersError, type BooksNotifier } from '../../../books/notifier.js';
import type { BooksToken } from '../../../quickbooks/books-token.js';
import { booksAuth } from '../books-auth.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface BooksMonitorRouteOptions {
  logger: Logger;
  store: MonitorStore;
  monitor: BooksMonitor;
  notifier: BooksNotifier;
  booksToken: BooksToken;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

const MAX_REPORT_BYTES = 256 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A list of short strings, or throws a readable reason. */
function strings(v: unknown, name: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > maxItems || v.some(x => typeof x !== 'string' || x.length > maxLen)) {
    throw new Error(`${name} must be a list of up to ${maxItems} strings of at most ${maxLen} characters`);
  }
  return v as string[];
}

export async function booksMonitorRoutes(app: FastifyInstance, options: BooksMonitorRouteOptions): Promise<void> {
  const { logger, store, monitor, notifier, booksToken, webAppBootstrapSecret, sessions } = options;
  const RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const authorised = booksAuth(booksToken, logger);

  app.post<{ Body: { at?: unknown; version?: unknown; state?: unknown; last_run_at?: unknown } }>(
    '/books/heartbeat',
    { bodyLimit: 4 * 1024, ...RATE },
    async (request, reply) => {
      if (!(await authorised(request, reply))) return reply;
      const b = request.body ?? {};
      const state = b.state === undefined ? null : b.state;
      if (state !== null && (typeof state !== 'string' || !['idle', 'running', 'deferred'].includes(state))) {
        return reply.status(400).send({ error: 'state must be idle, running or deferred' });
      }
      if (b.version !== undefined && (typeof b.version !== 'string' || b.version.length > 50)) {
        return reply.status(400).send({ error: 'version must be a string of at most 50 characters' });
      }
      let lastRunAt: Date | null = null;
      if (b.last_run_at !== undefined) {
        lastRunAt = typeof b.last_run_at === 'string' ? new Date(b.last_run_at) : new Date(NaN);
        if (Number.isNaN(lastRunAt.getTime())) return reply.status(400).send({ error: 'last_run_at must be an ISO date' });
      }
      await store.recordHeartbeat({ state, version: (b.version as string | undefined) ?? null, lastRunAt });
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    },
  );

  app.post<{ Body: { report?: unknown; accounts_received?: unknown; expected_accounts?: unknown; files?: unknown } }>(
    '/books/runs',
    { bodyLimit: MAX_REPORT_BYTES + 16 * 1024, ...RATE },
    async (request, reply) => {
      if (!(await authorised(request, reply))) return reply;
      const b = request.body ?? {};
      if (!isObject(b.report)) return reply.status(400).send({ error: 'report must be an object' });
      if (JSON.stringify(b.report).length > MAX_REPORT_BYTES) return reply.status(400).send({ error: 'report is too large (256 KB at most)' });
      const status = b.report.status;
      if (typeof status !== 'string' || !RUN_STATUSES.includes(status as RunStatus)) {
        return reply.status(400).send({ error: 'report.status must be ready, failed or deferred' });
      }
      try {
        const run = {
          status: status as RunStatus,
          batchId: typeof b.report.batch_id === 'string' && b.report.batch_id.length <= 64 ? b.report.batch_id : null,
          accountsReceived: strings(b.accounts_received, 'accounts_received', 50, 100),
          expectedAccounts: strings(b.expected_accounts, 'expected_accounts', 50, 100),
          files: strings(b.files, 'files', 200, 200),
          report: b.report,
        };
        await store.recordRun(run);
        // A failed notification must not lose the report that is already saved.
        await monitor.onRunReported(run).catch((err: unknown) => logger.error({ err }, 'books: could not announce a failed run'));
        return reply.header('Cache-Control', 'no-store').send({ ok: true });
      } catch (err) {
        if (err instanceof Error && /must be a list/.test(err.message)) return reply.status(400).send({ error: err.message });
        logger.error({ err }, 'books: recording a run failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  app.get('/api/books/status', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send(await monitor.status());
  });

  app.get('/api/books/reviewers', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send({ reviewers: await notifier.getReviewers() });
  });

  app.put<{ Body: { reviewers?: unknown } }>('/api/books/reviewers', { bodyLimit: 16 * 1024, ...RATE }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    try {
      return reply.header('Cache-Control', 'no-store').send({ reviewers: await notifier.setReviewers(request.body?.reviewers) });
    } catch (err) {
      if (err instanceof ReviewersError) return reply.status(400).send({ error: err.message });
      logger.error({ err }, 'books: saving reviewers failed');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
