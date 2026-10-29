// Briefing reads against Postgres (#2340 review): waiting counts, the histogram
// aggregate, contact counts and the bullpen query. The unit tests mock the pool.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import { BriefingService } from '../../src/dashboard/briefing-service.js';
import { HISTOGRAM_DAYS, addCalendarDays, localDayKey, localMidnight } from '../../src/dashboard/briefing.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('briefing service against Postgres', () => {
  let pool: pg.Pool;
  const logger = createSilentLogger();

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('counts seeded tasks, approvals, jobs and contacts in the principal window', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = await emptyFortnight(client);
      const today = localDayKey(now, 'UTC');
      const yesterday = addCalendarDays(today, -1);
      const bus = { publish: async () => {} } as unknown as EventBus;
      const service = new BriefingService({
        pool: client as unknown as pg.Pool,
        actionLogRepo: new ActionLogRepo(client as unknown as pg.Pool, logger),
        taskRepo: new TaskRepo(client as unknown as pg.Pool, bus, logger),
        contactService: { findContactBySystemRole: async () => null },
        officeTimezone: 'UTC',
        logger,
      });

      const beforeWaiting = await service.waiting(now);
      const weekStart = localMidnight(addCalendarDays(today, -(7 - 1)), 'UTC');
      const beforePeople = await client.query<{ total: number; recent: number }>(
        `SELECT count(*) FILTER (WHERE kind = 'person')::int AS total,
                count(*) FILTER (WHERE kind = 'person' AND created_at >= $1)::int AS recent
         FROM contacts`,
        [weekStart],
      );

      const title = `Briefing aggregate ${randomUUID()}`;
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at, due_at)
         VALUES ('coordinator', $1, 'seeded', 'open', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}', $2, $3)`,
        [title, now, new Date(now.getTime() - 86_400_000)],
      );
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
         VALUES ('coordinator', $1, 'seeded', 'open', '{}'::jsonb, '{}'::jsonb, 'curia', 50, 'agent', 'test', '{}', $2)`,
        [`${title} curia`, now],
      );
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
         VALUES ('coordinator', $1, 'seeded', 'done', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}', $2)`,
        [`${title} done`, now],
      );
      await client.query(
        `INSERT INTO autonomy_action_log
           (task_id, skill_name, action_risk, outcome, payload, description, expires_at, created_at)
         VALUES ('briefing-itest', 'email-send', 'medium', 'pending_approval', $1::jsonb, $2, '2099-01-01', $3)`,
        [JSON.stringify({ to: 'ada@example.com', subject: 'Renewal', body: 'Please sign.' }), `${title} approval`, now],
      );
      await client.query(
        `INSERT INTO autonomy_action_log
           (task_id, skill_name, action_risk, outcome, resolved_at, resolved_by, created_at)
         VALUES ('briefing-itest', 'email-send', 'medium', 'approved', $1, 'console', $1)`,
        [now],
      );
      await client.query(
        `INSERT INTO contacts (display_name, kind, created_at, updated_at)
         VALUES ($1, 'person', $2, $2)`,
        [`${title} person`, now],
      );

      const successRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 5 * 60_000),
        eventType: 'agent.task',
        payload: { agentId: 'coordinator' },
      });
      const successInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 4 * 60_000),
        eventType: 'tool.invoke',
        parentEventId: successRoot,
        payload: { toolName: 'email-archive' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 3 * 60_000),
        eventType: 'tool.result',
        parentEventId: successInvoke,
        outcome: 'success',
        payload: { result: { success: true } },
      });

      const partialRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000),
        eventType: 'agent.task',
        payload: { agentId: 'research' },
      });
      const partialInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 1000),
        eventType: 'tool.invoke',
        parentEventId: partialRoot,
        payload: { toolName: 'web-search' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 2000),
        eventType: 'tool.result',
        parentEventId: partialInvoke,
        outcome: 'success',
        payload: { result: { success: true } },
      });
      const delegated = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 3000),
        eventType: 'agent.task',
        payload: { agentId: 'specialist', metadata: { delegationOrigin: { taskEventId: partialRoot } } },
      });
      const delegatedInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 4000),
        eventType: 'tool.invoke',
        parentEventId: delegated,
        payload: { toolName: 'web-search' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 5000),
        eventType: 'tool.result',
        parentEventId: delegatedInvoke,
        outcome: 'failure',
        payload: { result: { success: false } },
      });

      const replyRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 3 * 3_600_000),
        eventType: 'agent.task',
        payload: { agentId: 'calendar' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 3 * 3_600_000 + 1000),
        eventType: 'agent.response',
        parentEventId: replyRoot,
        payload: { isError: true },
      });

      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 26 * 3_600_000),
        eventType: 'agent.task',
        payload: { agentId: 'ceo-inbox' },
      }).then(async (root) => {
        const invoke = await seedAudit(client, {
          timestamp: new Date(now.getTime() - 26 * 3_600_000 + 1000),
          eventType: 'tool.invoke',
          parentEventId: root,
          payload: { toolName: 'email-archive' },
        });
        await seedAudit(client, {
          timestamp: new Date(now.getTime() - 26 * 3_600_000 + 2000),
          eventType: 'tool.result',
          parentEventId: invoke,
          outcome: 'failure',
          payload: { result: { success: false } },
        });
      });

      await seedAudit(client, {
        timestamp: new Date(now.getTime() - (HISTOGRAM_DAYS + 3) * 86_400_000),
        eventType: 'agent.task',
        payload: { agentId: 'coordinator' },
      });

      const waiting = await service.waiting(now);
      expect(waiting.tasks.some((task) => task.title === title)).toBe(true);
      expect(waiting.curiaHandling - beforeWaiting.curiaHandling).toBe(1);
      expect(waiting.clearedToday - beforeWaiting.clearedToday).toBe(2);
      const approval = waiting.approvals.find((item) => item.title === `${title} approval`);
      expect(approval?.summary).toContain('Body: Please sign.');
      expect(approval?.needsDraft).toBe(false);

      const stats = await service.stats(now);
      const histogram = await service.histogram(now);
      const people = beforePeople.rows[0]!;
      expect(stats.contacts.total).toBe(Number(people.total) + 1);
      expect(stats.contacts.newThisWeek).toBe(Number(people.recent) + 1);
      expect(stats.hiccups.current).toBe(histogram.days.slice(-7).reduce((sum, day) => sum + day.hiccups, 0));

      const todayBar = histogram.days.find((day) => day.key === today);
      const yesterdayBar = histogram.days.find((day) => day.key === yesterday);
      expect(todayBar).toMatchObject({ total: 3, hiccups: 2 });
      expect(todayBar?.byAgent['coordinator']).toBe(1);
      expect(todayBar?.byAgent['research']).toBe(1);
      expect(todayBar?.byOutcome).toMatchObject({ success: 1, partial: 1, failed: 1 });
      expect(yesterdayBar).toMatchObject({ total: 1, hiccups: 1 });
      expect(stats.done.current).toBe(2);
      expect(stats.handledSinceYesterday).toBe(4);

      const bullpen = await service.bullpen(now);
      expect(bullpen).toEqual({ available: true, count: 1, agents: ['coordinator'] });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

async function emptyFortnight(client: pg.PoolClient): Promise<Date> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const day = new Date(Date.UTC(1972, 0, 1) + Math.floor(Math.random() * 6_000) * 86_400_000);
    day.setUTCHours(15, 0, 0, 0);
    const today = localDayKey(day, 'UTC');
    const from = localMidnight(addCalendarDays(today, -(HISTOGRAM_DAYS - 1)), 'UTC');
    const found = await client.query(
      'SELECT 1 FROM audit_log WHERE timestamp >= $1 AND timestamp < $2 LIMIT 1',
      [new Date(from.getTime() - 5 * 86_400_000), new Date(day.getTime() + 8 * 3_600_000)],
    );
    if (found.rowCount === 0) return day;
  }
  throw new Error('no unused audit_log fortnight for the briefing test');
}

async function seedAudit(
  client: pg.PoolClient,
  opts: {
    timestamp: Date;
    eventType: string;
    payload: Record<string, unknown>;
    parentEventId?: string;
    outcome?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO audit_log (id, timestamp, event_type, source_layer, source_id, payload, parent_event_id, outcome)
     VALUES ($1, $2, $3, 'test-briefing', 'coordinator', $4::jsonb, $5, $6)`,
    [id, opts.timestamp, opts.eventType, JSON.stringify(opts.payload), opts.parentEventId ?? null, opts.outcome ?? null],
  );
  return id;
}
