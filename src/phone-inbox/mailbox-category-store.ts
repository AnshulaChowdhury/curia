// mailbox-category-store.ts — the Work/Personal category of each phone-inbox mailbox, as reported by Command Hub.
//
// The phone is the source of truth. This store only remembers the last value it was told (table
// phone_mailbox_categories). Nothing here infers or edits a category, and no address is stored.

import type { DbPool } from '../db/connection.js';
import { PHONE_INBOX_ACCOUNT_IDS, type PhoneInboxAccountId } from './phone-inbox-service.js';

export const MAILBOX_CATEGORIES = ['WORK', 'PERSONAL'] as const;
export type MailboxCategory = (typeof MAILBOX_CATEGORIES)[number];

export function isMailboxCategory(value: unknown): value is MailboxCategory {
  return typeof value === 'string' && (MAILBOX_CATEGORIES as readonly string[]).includes(value);
}

export function isPhoneInboxAccountId(value: unknown): value is PhoneInboxAccountId {
  return typeof value === 'string' && (PHONE_INBOX_ACCOUNT_IDS as readonly string[]).includes(value);
}

export interface ReportedCategory {
  accountId: PhoneInboxAccountId;
  category: MailboxCategory;
  /** ISO-8601: when the phone last told us. */
  reportedAt: string;
  /** ISO-8601: when the value last changed. */
  changedAt: string;
}

export interface MailboxCategoryStore {
  /** Records what the phone reported. `changed` is true only when the value differs from the one already stored. */
  report(accountId: PhoneInboxAccountId, category: MailboxCategory): Promise<{ changed: boolean }>;
  get(accountId: PhoneInboxAccountId): Promise<ReportedCategory | null>;
  list(): Promise<ReportedCategory[]>;
}

export class InMemoryMailboxCategoryStore implements MailboxCategoryStore {
  private readonly rows = new Map<PhoneInboxAccountId, ReportedCategory>();

  async report(accountId: PhoneInboxAccountId, category: MailboxCategory): Promise<{ changed: boolean }> {
    const now = new Date().toISOString();
    const existing = this.rows.get(accountId);
    const changed = existing?.category !== category;
    this.rows.set(accountId, { accountId, category, reportedAt: now, changedAt: changed ? now : existing!.changedAt });
    return { changed };
  }

  async get(accountId: PhoneInboxAccountId): Promise<ReportedCategory | null> {
    return this.rows.get(accountId) ?? null;
  }

  async list(): Promise<ReportedCategory[]> {
    return [...this.rows.values()];
  }
}

interface Row {
  account_id: PhoneInboxAccountId;
  category: MailboxCategory;
  reported_at: Date;
  changed_at: Date;
}

const toReported = (r: Row): ReportedCategory => ({
  accountId: r.account_id,
  category: r.category,
  reportedAt: r.reported_at.toISOString(),
  changedAt: r.changed_at.toISOString(),
});

export class PgMailboxCategoryStore implements MailboxCategoryStore {
  constructor(private readonly pool: DbPool) {}

  async report(accountId: PhoneInboxAccountId, category: MailboxCategory): Promise<{ changed: boolean }> {
    // One statement. `prev` reads the value as it was before this statement (a data-modifying CTE does not see its
    // own writes), so `changed` is true for a first report and when the value differs, and false for a repeat.
    const result = await this.pool.query<{ changed: boolean }>(
      `WITH prev AS (SELECT category FROM phone_mailbox_categories WHERE account_id = $1),
            up AS (
              INSERT INTO phone_mailbox_categories AS t (account_id, category)
              VALUES ($1, $2)
              ON CONFLICT (account_id) DO UPDATE
                SET reported_at = now(),
                    changed_at = CASE WHEN t.category <> EXCLUDED.category THEN now() ELSE t.changed_at END,
                    category = EXCLUDED.category
              RETURNING 1
            )
       SELECT COALESCE((SELECT category FROM prev) <> $2::text, true) AS changed FROM up`,
      [accountId, category],
    );
    return { changed: result.rows[0]?.changed === true };
  }

  async get(accountId: PhoneInboxAccountId): Promise<ReportedCategory | null> {
    const result = await this.pool.query<Row>(`SELECT * FROM phone_mailbox_categories WHERE account_id = $1`, [accountId]);
    return result.rows[0] ? toReported(result.rows[0]) : null;
  }

  async list(): Promise<ReportedCategory[]> {
    const result = await this.pool.query<Row>(`SELECT * FROM phone_mailbox_categories ORDER BY account_id`);
    return result.rows.map(toReported);
  }
}
