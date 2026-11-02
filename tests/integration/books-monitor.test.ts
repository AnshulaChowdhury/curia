// The books monitor's SQL against real Postgres. Skips without DATABASE_URL.
//
// What matters: the heartbeat is one row stamped with the SERVER's clock; runs come back newest first within a window;
// notification state survives and overwrites; and the monitor finds the books scheduler job a person may have edited
// (cron, timezone, paused) but never a cancelled one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { MonitorStore } from '../../src/books/monitor-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('books monitor store', () => {
  let pool: pg.Pool;
  let store: MonitorStore;
  const marker = `it-${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new MonitorStore(pool);
    await pool.query('DELETE FROM books_runs');
    await pool.query('DELETE FROM books_heartbeat');
    await pool.query("DELETE FROM books_monitor_state WHERE key LIKE 'it-%'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM scheduled_jobs WHERE created_by = 'books' AND task_payload->>'marker' = $1", [marker]);
    await pool.query('DELETE FROM books_runs');
    await pool.query('DELETE FROM books_heartbeat');
    await pool.query("DELETE FROM books_monitor_state WHERE key LIKE 'it-%'");
    await pool.end();
  });

  it('keeps one heartbeat row stamped by the server', async () => {
    expect(await store.getHeartbeat()).toBeNull();
    await store.recordHeartbeat({ state: 'idle', version: 'v1', lastRunAt: null });
    await store.recordHeartbeat({ state: 'running', version: 'v2', lastRunAt: new Date('2026-11-02T10:00:00Z') });
    const hb = await store.getHeartbeat();
    expect(hb).toMatchObject({ state: 'running', version: 'v2' });
    expect(Math.abs(Date.now() - hb!.lastSeenAt.getTime())).toBeLessThan(60_000);
    expect((await pool.query('SELECT count(*)::int AS n FROM books_heartbeat')).rows[0].n).toBe(1);
  });

  it('records runs and returns them newest first within a window', async () => {
    await store.recordRun({ status: 'ready', batchId: 'aaaa1111', accountsReceived: ['a1'], expectedAccounts: ['a1', 'a2'], files: ['x.qbo'], report: { status: 'ready' } });
    await store.recordRun({ status: 'failed', batchId: null, accountsReceived: [], expectedAccounts: [], files: [], report: { status: 'failed', error: 'boom' } });
    const runs = await store.runsSince(new Date(Date.now() - 3600_000));
    expect(runs.map(r => r.status)).toEqual(['failed', 'ready']);
    expect(await store.runsSince(new Date(Date.now() + 3600_000))).toEqual([]);
    expect((await store.lastRun())?.status).toBe('failed');
    expect(await store.expectedAccounts()).toEqual(['a1', 'a2']); // the latest run that named any
  });

  it('refuses a run status outside ready, failed and deferred', async () => {
    await expect(pool.query("INSERT INTO books_runs (status) VALUES ('weird')")).rejects.toThrow();
  });

  it('stores and overwrites notification state', async () => {
    await store.setState('it-deadline', 'one');
    await store.setState('it-deadline', 'two');
    expect((await store.getState())['it-deadline']).toBe('two');
  });

  it('finds the books job with its edited timing, and ignores a cancelled one', async () => {
    const insert = (status: string, cron: string, kind: string) =>
      pool.query(
        `INSERT INTO scheduled_jobs (agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone)
         VALUES ('coordinator', $1, $2::jsonb, $3, now() + interval '1 day', 'books', 'America/Toronto')`,
        [cron, JSON.stringify({ task: 'checkpoint', books_job: kind, marker }), status],
      );
    await insert('cancelled', '0 9 * * 2', 'deadline');
    expect(await store.jobTiming('deadline')).toBeNull();
    await insert('pending', '0 12 * * 2', 'deadline');
    expect(await store.jobTiming('deadline')).toEqual({ cronExpr: '0 12 * * 2', timezone: 'America/Toronto', enabled: true });
    await pool.query("UPDATE scheduled_jobs SET status = 'paused' WHERE created_by = 'books' AND task_payload->>'marker' = $1 AND status = 'pending'", [marker]);
    expect((await store.jobTiming('deadline'))?.enabled).toBe(false);
  });
});
