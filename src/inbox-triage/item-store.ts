// item-store.ts — Postgres memory for inbox triage (table inbox_triage_items).
//
// Two jobs: it is the watcher's SeenStore (a restart never classifies a message twice), and it keeps the mail the
// classifier could not sort so the owner can categorise it from the phone. Sorted mail keeps ids only; the sender,
// subject and preview are stored just for unsorted mail, and cleared once the owner resolves it.

import type { DbPool } from '../db/connection.js';
import type { TriageCandidate } from './types.js';
import type { SeenStore } from './watcher.js';

export type UnsortedReason = 'none' | 'failed';
export type TriageOutcome = 'tagged' | UnsortedReason;

export interface UnsortedItem {
  accountId: string;
  messageId: string;
  threadId: string;
  from: string;
  /** The sender's address, when the provider gave one. */
  fromAddress: string;
  subject: string;
  snippet: string;
  /** ISO-8601, or null when the provider gave no date. */
  receivedAt: string | null;
  reason: UnsortedReason;
}

/** What the watcher reports back once a message has been handled. */
export interface OutcomeRecorder {
  record(candidate: TriageCandidate, outcome: TriageOutcome): Promise<void>;
}

interface Row {
  account_id: string;
  message_id: string;
  thread_id: string | null;
  sender: string | null;
  sender_address: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: Date | null;
  outcome: UnsortedReason;
}

const toItem = (r: Row): UnsortedItem => ({
  accountId: r.account_id,
  messageId: r.message_id,
  threadId: r.thread_id ?? '',
  from: r.sender ?? '',
  fromAddress: r.sender_address ?? '',
  subject: r.subject ?? '',
  snippet: r.snippet ?? '',
  receivedAt: r.received_at ? r.received_at.toISOString() : null,
  reason: r.outcome,
});

const COLUMNS = 'account_id, message_id, thread_id, sender, sender_address, subject, snippet, received_at, outcome';

export class PgTriageStore implements SeenStore, OutcomeRecorder {
  constructor(private readonly pool: DbPool) {}

  // Keys are "<account>:<messageId>". Account ids never contain a colon, so the first one splits them.
  private static split(key: string): [string, string] {
    const at = key.indexOf(':');
    return [key.slice(0, at), key.slice(at + 1)];
  }

  async has(key: string): Promise<boolean> {
    const [account, message] = PgTriageStore.split(key);
    const result = await this.pool.query(`SELECT 1 FROM inbox_triage_items WHERE account_id = $1 AND message_id = $2`, [account, message]);
    return result.rows.length > 0;
  }

  async add(key: string): Promise<void> {
    const [account, message] = PgTriageStore.split(key);
    await this.pool.query(
      `INSERT INTO inbox_triage_items (account_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [account, message],
    );
  }

  async record(c: TriageCandidate, outcome: TriageOutcome): Promise<void> {
    const keep = outcome !== 'tagged';
    await this.pool.query(
      `INSERT INTO inbox_triage_items (account_id, message_id, outcome, thread_id, sender, subject, snippet, received_at, sender_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::bigint > 0 THEN to_timestamp($8::bigint) END, $9)
       ON CONFLICT (account_id, message_id) DO UPDATE SET
         outcome = EXCLUDED.outcome, thread_id = EXCLUDED.thread_id, sender = EXCLUDED.sender,
         subject = EXCLUDED.subject, snippet = EXCLUDED.snippet, received_at = EXCLUDED.received_at,
         sender_address = EXCLUDED.sender_address`,
      [
        c.accountId, c.messageId, outcome,
        keep ? c.threadId : null, keep ? c.from : null, keep ? c.subject : null, keep ? c.snippet.slice(0, 300) : null,
        c.receivedAt, keep ? c.fromAddress ?? null : null,
      ],
    );
  }

  /** Unsorted mail waiting for the owner, newest first. */
  async listUnsorted(limit: number): Promise<UnsortedItem[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM inbox_triage_items WHERE outcome IN ('none', 'failed')
       ORDER BY received_at DESC NULLS LAST, created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toItem);
  }

  async countUnsorted(): Promise<number> {
    const result = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM inbox_triage_items WHERE outcome IN ('none', 'failed')`);
    return Number(result.rows[0]?.n ?? 0);
  }

  async getUnsorted(accountId: string, messageId: string): Promise<UnsortedItem | null> {
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM inbox_triage_items WHERE account_id = $1 AND message_id = $2 AND outcome IN ('none', 'failed')`,
      [accountId, messageId],
    );
    const row = result.rows[0];
    return row ? toItem(row) : null;
  }

  /** Marks the item resolved (group null = dismissed without a label) and drops its stored text. True if it was waiting. */
  async resolve(accountId: string, messageId: string, group: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE inbox_triage_items SET outcome = 'resolved', resolved_group = $3, resolved_at = now(),
         sender = NULL, sender_address = NULL, subject = NULL, snippet = NULL, thread_id = NULL
       WHERE account_id = $1 AND message_id = $2 AND outcome IN ('none', 'failed')`,
      [accountId, messageId, group],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
