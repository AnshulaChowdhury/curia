// history.ts — GET /api/history: what every agent did, with inputs and outputs, for Settings → History (ADR-072).
//
// Read only. Auth: session cookie or x-web-bootstrap-secret, as the other console routes; the phone's tokens do not
// open it.

import type { FastifyInstance } from 'fastify';
import type { HistoryRepo, HistoryWindow } from '../../../audit/history-repo.js';
import type { Logger } from '../../../logger.js';
import { isUuid } from '../../../util/uuid.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';

export interface HistoryRouteOptions {
  history: Pick<HistoryRepo, 'conversations' | 'facets' | 'steps' | 'detail'>;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  logger: Logger;
}

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

type Query = Record<string, string | undefined>;

/** The asked-for window, or a message saying why it cannot be read. */
function windowOf(query: Query): HistoryWindow | string {
  const to = query.to ? new Date(query.to) : new Date(Date.now() + 60_000);
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_LOOKBACK_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'Invalid from or to timestamp';
  return from < to ? { from, to } : 'from must be before to';
}

export async function historyRoutes(app: FastifyInstance, options: HistoryRouteOptions): Promise<void> {
  const { history, webAppBootstrapSecret, sessions, logger } = options;

  app.get('/api/history', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const query = request.query as Query;
    const window = windowOf(query);
    if (typeof window === 'string') return reply.status(400).send({ error: window });
    const offset = Number(query.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0) return reply.status(400).send({ error: 'Invalid offset' });
    try {
      const [page, facets] = await Promise.all([
        history.conversations({
          ...window, offset, errorsOnly: query.errors === '1',
          agent: query.agent || undefined, channel: query.channel || undefined,
        }),
        history.facets(window),
      ]);
      return reply.send({ ...page, ...facets });
    } catch (err) {
      logger.error({ err }, 'history list query failed');
      return reply.status(500).send({ error: 'Failed to load history' });
    }
  });

  // `conversation` is a query parameter because ids may hold slashes; without it, the events of no conversation.
  app.get('/api/history/steps', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const query = request.query as Query;
    const window = windowOf(query);
    if (typeof window === 'string') return reply.status(400).send({ error: window });
    if (query.before !== undefined && !/^\d{1,18}$/.test(query.before)) return reply.status(400).send({ error: 'Invalid before' });
    try {
      const page = await history.steps({ ...window, conversationId: query.conversation || null, before: query.before });
      // Semgrep direct-response-write flags a query value reaching reply.send as XSS. Not applicable: this sends an
      // object, which Fastify serializes as application/json, never HTML, with nosniff set app-wide (both pinned by
      // tests/unit/channels/http/history-routes.test.ts), and the console draws the text as text. The route is
      // session-authed. resp.render() is for HTML templates. Same pattern as the other console JSON routes.
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      return reply.send(page);
    } catch (err) {
      logger.error({ err, conversationId: query.conversation }, 'history steps query failed');
      return reply.status(500).send({ error: 'Failed to load history' });
    }
  });

  app.get('/api/history/events/:id', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(400).send({ error: 'Invalid event id' });
    try {
      const detail = await history.detail(id);
      return detail ? reply.send(detail) : reply.status(404).send({ error: 'Not found' });
    } catch (err) {
      logger.error({ err, eventId: id }, 'history detail query failed');
      return reply.status(500).send({ error: 'Failed to load history' });
    }
  });
}
