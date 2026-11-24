// unsubscribe-store.ts — senders the owner unsubscribed from through Curia (table inbox_unsubscribes), and how many
// times Curia has had to repeat the request because they kept mailing.

import type { DbPool } from '../db/connection.js';

export interface UnsubscribeRecord {
  unsubscribedAt: Date;
  /** When the owner first unsubscribed from this sender; never reset by a later unsubscribe. */
  firstUnsubscribedAt: Date;
  /** Retries made so far, 0 to MAX_RETRIES. */
  attempts: number;
  lastAttemptAt: Date | null;
  trashedAt: Date | null;
}

interface Row {
  unsubscribed_at: Date;
  first_unsubscribed_at: Date;
  attempts: number;
  last_attempt_at: Date | null;
  trashed_at: Date | null;
}

function toRecord(r: Row): UnsubscribeRecord {
  return {
    unsubscribedAt: r.unsubscribed_at, firstUnsubscribedAt: r.first_unsubscribed_at,
    attempts: r.attempts, lastAttemptAt: r.last_attempt_at, trashedAt: r.trashed_at,
  };
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
      `SELECT unsubscribed_at, first_unsubscribed_at, attempts, last_attempt_at, trashed_at FROM inbox_unsubscribes
       WHERE account_id = $1 AND sender_address = $2`,
      [accountId, senderAddress],
    );
    const r = result.rows[0];
    return r ? toRecord(r) : null;
  }

  /** The records for several sender addresses (lower-case) in one mailbox, keyed by address. Used by the morning brief. */
  async getMany(accountId: string, senderAddresses: string[]): Promise<Map<string, UnsubscribeRecord>> {
    const out = new Map<string, UnsubscribeRecord>();
    if (senderAddresses.length === 0) return out;
    const result = await this.pool.query<Row & { sender_address: string }>(
      `SELECT sender_address, unsubscribed_at, first_unsubscribed_at, attempts, last_attempt_at, trashed_at FROM inbox_unsubscribes
       WHERE account_id = $1 AND sender_address = ANY($2::text[])`,
      [accountId, senderAddresses],
    );
    for (const r of result.rows) out.set(r.sender_address, toRecord(r));
    return out;
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
