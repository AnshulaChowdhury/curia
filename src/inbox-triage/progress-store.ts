// progress-store.ts — the last time each mailbox was triaged in full (table inbox_triage_progress).
// Triage resumes from here after a restart, a deploy or an outage, instead of from a fixed date.

import type { DbPool } from '../db/connection.js';

export interface TriageProgress {
  /** Epoch milliseconds of the last full, successful pass over the mailbox; null if there has never been one. */
  get(accountId: string): Promise<number | null>;
  /** Records a successful pass. Never moves the mark backwards. */
  set(accountId: string, atMs: number): Promise<void>;
}

export class PgTriageProgressStore implements TriageProgress {
  constructor(private readonly pool: DbPool) {}

  async get(accountId: string): Promise<number | null> {
    const result = await this.pool.query<{ ms: string }>(
      `SELECT (EXTRACT(EPOCH FROM last_success_at) * 1000)::bigint AS ms FROM inbox_triage_progress WHERE account_id = $1`,
      [accountId],
    );
    const row = result.rows[0];
    return row ? Number(row.ms) : null;
  }

  async set(accountId: string, atMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO inbox_triage_progress (account_id, last_success_at) VALUES ($1, to_timestamp($2 / 1000.0))
       ON CONFLICT (account_id)
       DO UPDATE SET last_success_at = GREATEST(inbox_triage_progress.last_success_at, EXCLUDED.last_success_at)`,
      [accountId, atMs],
    );
  }
}
