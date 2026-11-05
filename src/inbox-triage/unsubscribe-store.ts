// unsubscribe-store.ts — senders the owner unsubscribed from through Curia (table inbox_unsubscribes), and how many
// times Curia has had to repeat the request because they kept mailing.

import type { DbPool } from '../db/connection.js';

export interface UnsubscribeRecord {
  unsubscribedAt: Date;
  /** Retries made so far, 0 to MAX_RETRIES. */
  attempts: number;
  lastAttemptAt: Date | null;
  trashedAt: Date | null;
}

interface Row {
  unsubscribed_at: Date;
  attempts: number;
  last_attempt_at: Date | null;
  trashed_at: Date | null;
}

export class PgUnsubscribeStore {
  constructor(private readonly pool: DbPool) {}

  /** Starts (or restarts) the clock for a sender the owner just unsubscribed from. */
  async record(accountId: string, senderAddress: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO inbox_unsubscribes (account_id, sender_address) VALUES ($1, $2)
       ON CONFLICT (account_id, sender_address)
       DO UPDATE SET unsubscribed_at = now(), attempts = 0, last_attempt_at = NULL, trashed_at = NULL`,
      [accountId, senderAddress],
    );
  }

  async get(accountId: string, senderAddress: string): Promise<UnsubscribeRecord | null> {
    const result = await this.pool.query<Row>(
      `SELECT unsubscribed_at, attempts, last_attempt_at, trashed_at FROM inbox_unsubscribes
       WHERE account_id = $1 AND sender_address = $2`,
      [accountId, senderAddress],
    );
    const r = result.rows[0];
    return r ? { unsubscribedAt: r.unsubscribed_at, attempts: r.attempts, lastAttemptAt: r.last_attempt_at, trashedAt: r.trashed_at } : null;
  }

  /** Counts one retry, but only if the count is still `expected` (so two passes never count the same one twice). */
  async countAttempt(accountId: string, senderAddress: string, expected: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE inbox_unsubscribes SET attempts = attempts + 1, last_attempt_at = now()
       WHERE account_id = $1 AND sender_address = $2 AND attempts = $3 AND attempts < 3 AND trashed_at IS NULL`,
      [accountId, senderAddress, expected],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markTrashed(accountId: string, senderAddress: string): Promise<void> {
    await this.pool.query(
      `UPDATE inbox_unsubscribes SET trashed_at = COALESCE(trashed_at, now()) WHERE account_id = $1 AND sender_address = $2`,
      [accountId, senderAddress],
    );
  }
}
