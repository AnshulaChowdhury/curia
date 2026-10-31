// activity.ts — GET /api/activity: the console home's job-level activity feed (#2251).
//
// Returns ActivityItem[] newest first: one item per job, in words ("drafted a
// reply to John Doe"), never tool names or message bodies. See src/activity/.
//
// Query: from (ISO, default now-24h), to (ISO, default now), limit (default 20, max 100).
// Auth: session cookie or x-web-bootstrap-secret (same as the other console routes).

import type { FastifyInstance } from 'fastify';
import type { ActivityFeedSource } from '../../../activity/activity-service.js';
import type { Logger } from '../../../logger.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface ActivityRouteOptions {
  activity: ActivityFeedSource;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  logger: Logger;
}

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseDate(value: string | undefined): Date | null | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function activityRoutes(app: FastifyInstance, options: ActivityRouteOptions): Promise<void> {
  const { activity, webAppBootstrapSecret, sessions, logger } = options;

  app.get('/api/activity', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as { from?: string; to?: string; limit?: string };
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from === null) return reply.status(400).send({ error: 'Invalid from timestamp' });
    if (to === null) return reply.status(400).send({ error: 'Invalid to timestamp' });

    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - DEFAULT_LOOKBACK_MS);
    if (start >= end) return reply.status(400).send({ error: 'from must be before to' });

    const parsedLimit = query.limit ? Number.parseInt(query.limit, 10) : DEFAULT_LIMIT;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return reply.status(400).send({ error: 'Invalid limit' });
    }
    const limit = Math.min(parsedLimit, MAX_LIMIT);

    try {
      const page = await activity.list({ from: start, to: end, limit });
      return reply.send(page);
    } catch (err) {
      logger.error({ err }, 'activity feed query failed');
      return reply.status(500).send({ error: 'Failed to load activity' });
    }
  });
}
