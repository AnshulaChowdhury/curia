// Unit tests for GET /api/activity — auth, query parsing, error sanitization.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityRoutes } from '../../../../src/channels/http/routes/activity.js';
import type { ActivityFeedSource } from '../../../../src/activity/activity-service.js';
import { createSilentLogger } from '../../../../src/logger.js';

const TEST_SECRET = 'test-activity-secret';
const AUTH_HEADER = { 'x-web-bootstrap-secret': TEST_SECRET };

let app: FastifyInstance | undefined;

async function build(list: ActivityFeedSource['list']) {
  app = Fastify();
  const logger = createSilentLogger();
  await app.register(activityRoutes, {
    activity: { list },
    webAppBootstrapSecret: TEST_SECRET,
    sessions: new Map(),
    logger,
  });
  await app.ready();
  return { app, logger };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/activity', () => {
  it('rejects a request without the secret or a session', async () => {
    const list = vi.fn();
    const { app } = await build(list);
    const res = await app.inject({ method: 'GET', url: '/api/activity' });
    expect(res.statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it('defaults to the last 24h and 20 items, and returns the page', async () => {
    const page = { items: [], hasMore: false, timezone: 'UTC' };
    const list = vi.fn().mockResolvedValue(page);
    const { app } = await build(list);
    const before = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/activity', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(page);
    const query = list.mock.calls[0]![0] as { from: Date; to: Date; limit: number };
    expect(query.limit).toBe(20);
    expect(query.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(query.to.getTime() - query.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('caps limit and rejects bad input', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], hasMore: false, timezone: 'UTC' });
    const { app } = await build(list);
    await app.inject({ method: 'GET', url: '/api/activity?limit=5000', headers: AUTH_HEADER });
    expect((list.mock.calls[0]![0] as { limit: number }).limit).toBe(100);
    for (const url of ['/api/activity?from=nope', '/api/activity?limit=0', '/api/activity?from=2026-10-24T10:00:00Z&to=2026-10-24T09:00:00Z']) {
      const res = await app.inject({ method: 'GET', url, headers: AUTH_HEADER });
      expect(res.statusCode).toBe(400);
    }
  });

  it('returns a generic 500 body when the feed fails', async () => {
    const { app, logger } = await build(vi.fn().mockRejectedValue(new Error('relation "audit_log" does not exist')));
    const error = vi.spyOn(logger, 'error');
    const res = await app.inject({ method: 'GET', url: '/api/activity', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to load activity' });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'activity feed query failed');
  });
});
