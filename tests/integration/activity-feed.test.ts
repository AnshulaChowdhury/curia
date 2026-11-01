// Integration tests for the activity feed's read path (#2251): AuditLogRepo.findActivityJobs
// against real Postgres, then ActivityService over it.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { ActivityService } from '../../src/activity/activity-service.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('activity feed read path', () => {
  let pool: pg.Pool;
  let repo: AuditLogRepo;
  const logger = createSilentLogger();
  const sourceLayer = 'test-activity-feed';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new AuditLogRepo(pool, logger);
    await pool.query('SELECT 1 FROM audit_log LIMIT 0');
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * A day between 1971 and 2019 that holds no audit_log rows yet. audit_log is append-only and
   * these rows outlive the run, so a random day alone could land on one an earlier run (or an
   * earlier test here) already filled. The checked span covers the test's one-day window plus
   * the repo's 6h delegation tail.
   */
  async function isolatedDay(): Promise<Date> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const day = new Date(Date.UTC(1971, 0, 1) + Math.floor(Math.random() * 17_500) * 86_400_000);
      const { rowCount } = await pool.query(
        'SELECT 1 FROM audit_log WHERE timestamp >= $1 AND timestamp < $2 LIMIT 1',
        [day, new Date(day.getTime() + 2 * 86_400_000)],
      );
      if (rowCount === 0) return day;
    }
    throw new Error('no unused audit_log day found for the activity feed test');
  }

  async function seed(opts: {
    timestamp: Date;
    eventType: string;
    payload?: Record<string, unknown>;
    conversationId?: string;
    parentEventId?: string | null;
    outcome?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO audit_log (id, timestamp, event_type, source_layer, source_id, payload, conversation_id, parent_event_id, outcome)
       VALUES ($1, $2, $3, $4, 'coordinator', $5::jsonb, $6, $7, $8)`,
      [id, opts.timestamp, opts.eventType, sourceLayer, JSON.stringify(opts.payload ?? {}), opts.conversationId ?? 'conv-activity', opts.parentEventId ?? null, opts.outcome ?? null],
    );
    return id;
  }

  async function seedArchiveJob(at: Date, subject: string): Promise<string> {
    const taskId = await seed({ timestamp: at, eventType: 'agent.task', payload: { agentId: 'coordinator', channelId: 'email', content: 'x' } });
    const invokeId = await seed({
      timestamp: new Date(at.getTime() + 1000), eventType: 'tool.invoke', parentEventId: taskId,
      payload: { toolName: 'ceo-inbox-archive', input: { message_id: subject } },
    });
    await seed({
      timestamp: new Date(at.getTime() + 2000), eventType: 'tool.result', parentEventId: invokeId, outcome: 'success',
      payload: { toolName: 'ceo-inbox-archive', result: { success: true, data: { subject } } },
    });
    return taskId;
  }

  it('returns the newest jobs when the window holds more than the limit', async () => {
    const day = await isolatedDay();
    const taskIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      taskIds.push(await seedArchiveJob(new Date(day.getTime() + i * 30 * 60_000), `job-${i}`));
    }
    const from = day;
    const to = new Date(day.getTime() + 86_400_000);

    const page = await repo.findActivityJobs({ from, to, limit: 20 });
    expect(page.hasMore).toBe(true);
    expect(page.roots.map((r) => r.id)).toEqual(taskIds.slice(5).reverse());
    // Each root's invoke and result came with it.
    expect(page.children.filter((r) => r.eventType === 'tool.result')).toHaveLength(20);

    // Through the service: newest first, oldest five left out.
    const service = new ActivityService({
      auditLogRepo: repo,
      contactService: {
        getContact: async () => undefined,
        findContactBySystemRole: async () => null,
        resolveByChannelIdentity: async () => null,
      },
      officeTimezone: 'UTC',
      logger,
    });
    const feed = await service.list({ from, to, limit: 20 });
    expect(feed.items).toHaveLength(20);
    expect(feed.items[0]!.id).toBe(taskIds[24]);
    expect(feed.items[19]!.id).toBe(taskIds[5]);
    expect(feed.items.every((i) => i.headline === 'archived an email')).toBe(true);
    const ts = feed.items.map((i) => i.ts);
    expect(ts).toEqual([...ts].sort().reverse());
  });

  it('pages older roots with the keyset cursor', async () => {
    const day = await isolatedDay();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seed({ timestamp: new Date(day.getTime() + i * 60_000), eventType: 'agent.task', payload: { agentId: 'coordinator', channelId: 'email' } }));
    }
    const window = { from: day, to: new Date(day.getTime() + 86_400_000) };
    const first = await repo.findActivityJobs({ ...window, limit: 2 });
    expect(first.roots.map((r) => r.id)).toEqual([ids[4], ids[3]]);
    expect(first.nextCursor).toBeDefined();
    const second = await repo.findActivityJobs({ ...window, limit: 2, before: first.nextCursor });
    expect(second.roots.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    const third = await repo.findActivityJobs({ ...window, limit: 2, before: second.nextCursor });
    expect(third.roots.map((r) => r.id)).toEqual([ids[0]]);
    expect(third.hasMore).toBe(false);
  });

  it('fills the feed past a page of roots that project to nothing', async () => {
    const day = await isolatedDay();
    const visible = await seedArchiveJob(day, 'old-but-visible');
    // 60 newer roots with no tool work and no reply: more than one page at limit=1.
    for (let i = 1; i <= 60; i++) {
      await seed({ timestamp: new Date(day.getTime() + i * 60_000), eventType: 'agent.task', payload: { agentId: 'coordinator', channelId: 'email' } });
    }
    const service = new ActivityService({
      auditLogRepo: repo,
      contactService: { getContact: async () => undefined, findContactBySystemRole: async () => null, resolveByChannelIdentity: async () => null },
      officeTimezone: 'UTC',
      logger,
    });
    const feed = await service.list({ from: day, to: new Date(day.getTime() + 86_400_000), limit: 1 });
    expect(feed.items.map((i) => i.id)).toEqual([visible]);
    expect(feed.hasMore).toBe(false);
  });

  it('reads delegated specialist work and the summary under the root, not as roots', async () => {
    const day = await isolatedDay();
    const rootId = await seed({ timestamp: day, eventType: 'agent.task', payload: { agentId: 'coordinator', channelId: 'signal', content: 'x' } });
    const specialistId = await seed({
      timestamp: new Date(day.getTime() + 1000), eventType: 'agent.task', conversationId: 'delegate-1',
      payload: { agentId: 'calendar', channelId: 'internal', content: 'y', metadata: { delegationOrigin: { taskEventId: rootId } } },
    });
    const nestedId = await seed({
      timestamp: new Date(day.getTime() + 2000), eventType: 'agent.task', conversationId: 'delegate-2',
      payload: { agentId: 'contacts', channelId: 'internal', content: 'z', metadata: { delegationOrigin: { taskEventId: specialistId } } },
    });
    const invokeId = await seed({
      timestamp: new Date(day.getTime() + 3000), eventType: 'tool.invoke', parentEventId: nestedId,
      payload: { toolName: 'contact-create', input: { name: 'Jane Roe' } },
    });
    await seed({
      timestamp: new Date(day.getTime() + 4000), eventType: 'tool.result', parentEventId: invokeId, outcome: 'success',
      payload: { toolName: 'contact-create', result: { success: true, data: { display_name: 'Jane Roe' } } },
    });
    await seed({ timestamp: new Date(day.getTime() + 5000), eventType: 'activity.summary', parentEventId: rootId, payload: { summary: 'set up a meeting' } });
    // Two more levels: past the old three-level cap.
    const level3 = await seed({
      timestamp: new Date(day.getTime() + 6000), eventType: 'agent.task', conversationId: 'delegate-3',
      payload: { agentId: 'research', channelId: 'internal', content: 'a', metadata: { delegationOrigin: { taskEventId: nestedId } } },
    });
    const level4 = await seed({
      timestamp: new Date(day.getTime() + 7000), eventType: 'agent.task', conversationId: 'delegate-4',
      payload: { agentId: 'research', channelId: 'internal', content: 'b', metadata: { delegationOrigin: { taskEventId: level3 } } },
    });

    const page = await repo.findActivityJobs({ from: day, to: new Date(day.getTime() + 86_400_000), limit: 20 });
    expect(page.roots.map((r) => r.id)).toEqual([rootId]);
    expect(page.delegated.map((r) => r.id).sort()).toEqual([specialistId, nestedId, level3, level4].sort());
    expect(page.children.map((r) => r.eventType).sort()).toEqual(['activity.summary', 'tool.invoke', 'tool.result']);
  });
});
