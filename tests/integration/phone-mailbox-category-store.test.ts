// Mailbox category store against real Postgres (migration 118). Skips without DATABASE_URL.
//
// The properties that matter:
//   - the first report and any change say "changed"; a repeat of the same value says "unchanged";
//   - the table only accepts the three account ids and the two categories;
//   - the last value wins and is kept (no expiry).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PgMailboxCategoryStore } from '../../src/phone-inbox/mailbox-category-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('phone mailbox category store', () => {
  let pool: pg.Pool;
  let store: PgMailboxCategoryStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new PgMailboxCategoryStore(pool);
  });
  beforeEach(async () => { await pool.query('DELETE FROM phone_mailbox_categories'); });
  afterAll(async () => { await pool.query('DELETE FROM phone_mailbox_categories'); await pool.end(); });

  it('reports changed on first report and on a new value, unchanged on a repeat', async () => {
    expect(await store.report('moonray', 'WORK')).toEqual({ changed: true });
    expect(await store.report('moonray', 'WORK')).toEqual({ changed: false });
    expect(await store.report('moonray', 'PERSONAL')).toEqual({ changed: true });
    expect((await store.get('moonray'))?.category).toBe('PERSONAL');
  });

  it('a repeat moves reported_at but not changed_at', async () => {
    await store.report('personal', 'PERSONAL');
    const first = await store.get('personal');
    await new Promise((r) => setTimeout(r, 20));
    await store.report('personal', 'PERSONAL');
    const second = await store.get('personal');
    expect(second!.changedAt).toBe(first!.changedAt);
    expect(Date.parse(second!.reportedAt)).toBeGreaterThan(Date.parse(first!.reportedAt));
  });

  it('keeps one row per account and lists them', async () => {
    await store.report('personal', 'PERSONAL');
    await store.report('moonray', 'WORK');
    await store.report('moonray', 'WORK');
    expect((await store.list()).map((r) => `${r.accountId}:${r.category}`)).toEqual(['moonray:WORK', 'personal:PERSONAL']);
    expect(await store.get('work-outlook')).toBeNull();
  });

  it('refuses an unknown account id or category at the database', async () => {
    await expect(pool.query("INSERT INTO phone_mailbox_categories (account_id, category) VALUES ('other', 'WORK')")).rejects.toThrow();
    await expect(pool.query("INSERT INTO phone_mailbox_categories (account_id, category) VALUES ('personal', 'BOTH')")).rejects.toThrow();
  });
});
