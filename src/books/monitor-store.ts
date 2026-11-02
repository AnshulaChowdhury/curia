// monitor-store.ts — Postgres access for the books monitor: heartbeat, run reports, notification state, job timing.

import type { DbPool } from '../db/connection.js';
import type { JobTiming, MonitorState, RunFact } from './monitor-logic.js';

export type RunStatus = 'ready' | 'failed' | 'deferred';
export const RUN_STATUSES: readonly RunStatus[] = ['ready', 'failed', 'deferred'];
export type BooksJobKind = 'reminder' | 'deadline';

export interface NewRun {
  status: RunStatus;
  batchId: string | null;
  accountsReceived: string[];
  expectedAccounts: string[];
  files: string[];
  report: Record<string, unknown>;
}

interface RunRow {
  received_at: Date;
  status: RunStatus;
  accounts_received: string[];
  expected_accounts: string[];
  batch_id?: string | null;
}

const toFact = (r: RunRow): RunFact => ({
  receivedAt: r.received_at,
  status: r.status,
  accountsReceived: r.accounts_received,
  expectedAccounts: r.expected_accounts,
});

export class MonitorStore {
  constructor(private readonly pool: DbPool) {}

  /** The check-in time is the server's clock, so a skewed Mac mini clock cannot hide an outage. */
  async recordHeartbeat(h: { state: string | null; version: string | null; lastRunAt: Date | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO books_heartbeat (id, last_seen_at, state, version, last_run_at) VALUES (1, now(), $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), state = $1, version = $2, last_run_at = $3`,
      [h.state, h.version, h.lastRunAt],
    );
  }

  async getHeartbeat(): Promise<{ lastSeenAt: Date; state: string | null; version: string | null } | null> {
    const { rows } = await this.pool.query<{ last_seen_at: Date; state: string | null; version: string | null }>(
      'SELECT last_seen_at, state, version FROM books_heartbeat WHERE id = 1',
    );
    const r = rows[0];
    return r ? { lastSeenAt: r.last_seen_at, state: r.state, version: r.version } : null;
  }

  async recordRun(run: NewRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO books_runs (status, batch_id, accounts_received, expected_accounts, files, report)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [run.status, run.batchId, run.accountsReceived, run.expectedAccounts, run.files, JSON.stringify(run.report)],
    );
  }

  /** Runs received at or after `since`, newest first. */
  async runsSince(since: Date): Promise<RunFact[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT received_at, status, accounts_received, expected_accounts FROM books_runs
        WHERE received_at >= $1 ORDER BY received_at DESC LIMIT 200`,
      [since],
    );
    return rows.map(toFact);
  }

  async lastRun(): Promise<(RunFact & { batchId: string | null }) | null> {
    const { rows } = await this.pool.query<RunRow>(
      'SELECT received_at, status, accounts_received, expected_accounts, batch_id FROM books_runs ORDER BY received_at DESC LIMIT 1',
    );
    const r = rows[0];
    return r ? { ...toFact(r), batchId: r.batch_id ?? null } : null;
  }

  /** The accounts a file is expected for, from the latest run report that named any. */
  async expectedAccounts(): Promise<string[]> {
    const { rows } = await this.pool.query<{ expected_accounts: string[] }>(
      `SELECT expected_accounts FROM books_runs WHERE cardinality(expected_accounts) > 0 ORDER BY received_at DESC LIMIT 1`,
    );
    return rows[0]?.expected_accounts ?? [];
  }

  async getState(): Promise<MonitorState> {
    const { rows } = await this.pool.query<{ key: string; value: unknown }>('SELECT key, value FROM books_monitor_state');
    const state: MonitorState = {};
    for (const r of rows) if (typeof r.value === 'string') state[r.key] = r.value;
    return state;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO books_monitor_state (key, value, updated_at) VALUES ($1, to_jsonb($2::text), now())
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb($2::text), updated_at = now()`,
      [key, value],
    );
  }

  /** The books scheduler job of this kind (cron and timezone as the owner has edited them), or null when none/cancelled. */
  async jobTiming(kind: BooksJobKind): Promise<JobTiming | null> {
    const { rows } = await this.pool.query<{ cron_expr: string | null; timezone: string; status: string }>(
      `SELECT cron_expr, timezone, status FROM scheduled_jobs
        WHERE created_by = 'books' AND task_payload->>'books_job' = $1 AND status <> 'cancelled'
        ORDER BY created_at DESC LIMIT 1`,
      [kind],
    );
    const r = rows[0];
    if (!r?.cron_expr) return null;
    return { cronExpr: r.cron_expr, timezone: r.timezone, enabled: r.status === 'pending' || r.status === 'running' };
  }
}
