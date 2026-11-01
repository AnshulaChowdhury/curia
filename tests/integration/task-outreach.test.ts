// tests/integration/task-outreach.test.ts
//
// TaskOutreachRepo against real Postgres: array overlap/containment, the merge-on-record
// UPDATE, and the open/closed/expired filters are SQL semantics a mock cannot show.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TaskOutreachRepo, type TaskOutreachInput } from '../../src/dispatch/task-outreach.js';
import type { TaskOriginator } from '../../src/contacts/types.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('task_outreach repo', () => {
  let pool: pg.Pool;
  let repo: TaskOutreachRepo;
  let dbVerified = false;
  const taskIds: string[] = [];
  // Fresh per run: the shared test DB carries other suites' rows.
  const run = randomUUID().slice(0, 8);
  const originator: TaskOriginator = {
    contactId: randomUUID(),
    systemRole: null,
    channel: 'signal',
    initiatedAt: new Date().toISOString(),
  };

  async function seedTask(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (agent_id, intent_anchor, error_budget, status, title)
       VALUES ('test-agent', 'outreach test', '{}'::jsonb, 'pending', 'outreach test') RETURNING id`,
    );
    const id = rows[0]!.id;
    taskIds.push(id);
    return id;
  }

  function input(taskId: string | null, overrides: Partial<TaskOutreachInput> = {}): TaskOutreachInput {
    return {
      taskId,
      rootTaskId: null,
      conversationId: null,
      directingEventId: null,
      originator,
      via: 'email',
      orgName: null,
      domains: [`${run}-acme.test`],
      addresses: [`Bob@${run}-acme.test`],
      contactIds: [],
      givenContact: null,
      summary: 'asked about an invoice',
      confirmed: true,
      ...overrides,
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    await pool.query('SELECT id FROM task_outreach LIMIT 0');
    repo = new TaskOutreachRepo(pool);
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query('DELETE FROM task_outreach WHERE domains && $1::text[] OR conversation_id LIKE $2', [
        [`${run}-acme.test`, `${run}-other.test`], `${run}-%`,
      ]);
      await pool.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [taskIds]);
    }
    await pool.end();
  });

  it('records, finds, learns, closes, and then no longer finds', async () => {
    const taskId = await seedTask();
    const row = await repo.record(input(taskId));
    expect(row.addresses).toEqual([`bob@${run}-acme.test`]);
    expect(row.originator.contactId).toBe(originator.contactId);

    expect((await repo.findOpenByDomain(`${run.toUpperCase()}-ACME.test`)).map((r) => r.id)).toContain(row.id);
    expect((await repo.findOpenByAddress(`BOB@${run}-acme.test`)).map((r) => r.id)).toContain(row.id);

    const contactId = randomUUID();
    await repo.learnCounterparty(row.id, { address: `Alice@${run}-acme.test`, contactId });
    expect((await repo.findOpenByContact(contactId)).map((r) => r.id)).toContain(row.id);
    expect((await repo.findOpenByAddress(`alice@${run}-acme.test`)).map((r) => r.id)).toContain(row.id);

    expect(await repo.closeForTask(taskId)).toBe(1);
    expect((await repo.findOpenByDomain(`${run}-acme.test`)).map((r) => r.id)).not.toContain(row.id);
    expect((await repo.findOpen(500)).map((r) => r.id)).not.toContain(row.id);
    expect(await repo.closeForTask(taskId)).toBe(0);

    // Reopening the task reopens its unexpired rows, then closing them again works as before.
    expect(await repo.reopenForTask(taskId)).toBe(1);
    expect((await repo.findOpenByDomain(`${run}-acme.test`)).map((r) => r.id)).toContain(row.id);
    expect(await repo.closeForTask(taskId)).toBe(1);

    // A closed row learns nothing more.
    await repo.learnCounterparty(row.id, { address: `late@${run}-acme.test` });
    const { rows: [after] } = await pool.query<{ addresses: string[] }>('SELECT addresses FROM task_outreach WHERE id = $1', [row.id]);
    expect(after!.addresses).not.toContain(`late@${run}-acme.test`);
  });

  it('merges overlapping outreach for the same task and via instead of inserting', async () => {
    const taskId = await seedTask();
    const first = await repo.record(input(taskId));
    const second = await repo.record(input(taskId, {
      domains: [`${run}-acme.test`, `${run}-other.test`],
      addresses: [`carol@${run}-other.test`],
      orgName: 'Acme',
    }));
    expect(second.id).toBe(first.id);
    expect(second.domains).toEqual([`${run}-acme.test`, `${run}-other.test`].sort());
    expect(second.addresses).toHaveLength(2);
    expect(second.orgName).toBe('Acme');
  });

  it('does not merge across a different via, a different task, or without overlap', async () => {
    const taskId = await seedTask();
    const base = await repo.record(input(taskId));
    const otherVia = await repo.record(input(taskId, { via: 'web_form' }));
    const otherTask = await repo.record(input(await seedTask()));
    const noOverlap = await repo.record(input(taskId, { domains: [`${run}-other.test`], addresses: [] }));
    expect(new Set([base.id, otherVia.id, otherTask.id, noOverlap.id]).size).toBe(4);
  });

  it('a repeated backstop write merges into its own unconfirmed row (#2312)', async () => {
    const taskId = await seedTask();
    const form = { via: 'web_form' as const, domains: [`${run}-form.test`], addresses: [], confirmed: false };
    const backstop = await repo.record(input(taskId, form));
    expect(backstop.confirmed).toBe(false);
    // A second matching type step on the same page: same task, via and domain.
    const again = await repo.record(input(taskId, form));
    expect(again.id).toBe(backstop.id);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM task_outreach WHERE task_id = $1`, [taskId]);
    expect(rows[0].n).toBe(1);
  });

  it('an unconfirmed write overlapping a confirmed row gets a separate row (#2312)', async () => {
    const taskId = await seedTask();
    const confirmedRow = await repo.record(input(taskId));
    const guessed = await repo.record(input(taskId, {
      confirmed: false,
      addresses: [`Bob@${run}-acme.test`, `mallory@${run}-acme.test`],
    }));
    expect(guessed.id).not.toBe(confirmedRow.id);
    expect(guessed.confirmed).toBe(false);
    const reread = await repo.getById(confirmedRow.id);
    expect(reread?.confirmed).toBe(true);
    expect(reread?.addresses).toEqual([`bob@${run}-acme.test`]);
  });

  it('a confirmed write overlapping an unconfirmed row never upgrades it (#2312)', async () => {
    const taskId = await seedTask();
    const guessed = await repo.record(input(taskId, {
      confirmed: false,
      addresses: [`Bob@${run}-acme.test`, `mallory@${run}-acme.test`],
    }));
    const explicit = await repo.record(input(taskId));
    expect(explicit.id).not.toBe(guessed.id);
    expect(explicit.confirmed).toBe(true);
    expect(explicit.addresses).toEqual([`bob@${run}-acme.test`]);
    const reread = await repo.getById(guessed.id);
    expect(reread?.confirmed).toBe(false);
    // A second confirmed act merges into the confirmed row, not the unconfirmed one.
    const again = await repo.record(input(taskId, { addresses: [`carol@${run}-acme.test`] }));
    expect(again.id).toBe(explicit.id);
    expect(again.confirmed).toBe(true);
    expect((await repo.getById(guessed.id))?.addresses).not.toContain(`carol@${run}-acme.test`);
  });

  it('a column omitted on insert defaults to unconfirmed (#2312)', async () => {
    const taskId = await seedTask();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO task_outreach (task_id, originator, via, domains, summary)
       VALUES ($1, $2, 'email', $3, 'default check') RETURNING id`,
      [taskId, JSON.stringify(originator), [`${run}-acme.test`]],
    );
    expect((await repo.getById(rows[0]!.id))?.confirmed).toBe(false);
  });

  it('merges by conversation_id when there is no task', async () => {
    const conversationId = `${run}-conv`;
    const first = await repo.record(input(null, { conversationId }));
    const second = await repo.record(input(null, { conversationId, addresses: [`dan@${run}-acme.test`] }));
    expect(second.id).toBe(first.id);
    const elsewhere = await repo.record(input(null, { conversationId: `${run}-conv2` }));
    expect(elsewhere.id).not.toBe(first.id);
  });

  it('excludes expired rows', async () => {
    const taskId = await seedTask();
    const row = await repo.record(input(taskId, { domains: [`${run}-other.test`], addresses: [] }));
    expect((await repo.findOpenByDomain(`${run}-other.test`)).map((r) => r.id)).toContain(row.id);
    await pool.query(`UPDATE task_outreach SET expires_at = now() - interval '1 minute' WHERE id = $1`, [row.id]);
    expect((await repo.findOpenByDomain(`${run}-other.test`)).map((r) => r.id)).not.toContain(row.id);
    expect((await repo.findOpen(500)).map((r) => r.id)).not.toContain(row.id);
  });
});
