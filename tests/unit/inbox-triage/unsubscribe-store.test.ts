import { describe, expect, it, vi } from 'vitest';
import { PgUnsubscribeStore } from '../../../src/inbox-triage/unsubscribe-store.js';
import type { DbPool } from '../../../src/db/connection.js';

const pool = (rows: unknown[] = [], rowCount = 1) => {
  const query = vi.fn(async (..._a: unknown[]) => ({ rows, rowCount }));
  return { store: new PgUnsubscribeStore({ query } as unknown as DbPool), query };
};
const args = (q: ReturnType<typeof vi.fn>, n = 0) => q.mock.calls[n] as unknown as [string, unknown[]];

describe('PgUnsubscribeStore', () => {
  it('starts the clock again when the owner unsubscribes a second time', async () => {
    const { store, query } = pool();
    await store.record('moonray', 'news@x.com');
    expect(args(query)[0]).toMatch(/DO UPDATE SET unsubscribed_at = now\(\), attempts = 0, last_attempt_at = NULL, trashed_at = NULL/);
    expect(args(query)[1]).toEqual(['moonray', 'news@x.com']);
  });

  it('reads a record back, or null', async () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const row = { unsubscribed_at: at, attempts: 2, last_attempt_at: at, trashed_at: null };
    expect(await pool([row]).store.get('moonray', 'a@x.com')).toEqual({ unsubscribedAt: at, attempts: 2, lastAttemptAt: at, trashedAt: null });
    expect(await pool([]).store.get('moonray', 'a@x.com')).toBeNull();
  });

  it('counts a try only if the count is still what the caller saw, and never past three or once trashed', async () => {
    const { store, query } = pool([], 1);
    expect(await store.countAttempt('moonray', 'a@x.com', 1)).toBe(true);
    expect(args(query)[0]).toMatch(/attempts = \$3 AND attempts < 3 AND trashed_at IS NULL/);
    expect(args(query)[1]).toEqual(['moonray', 'a@x.com', 1]);
    expect(await pool([], 0).store.countAttempt('moonray', 'a@x.com', 1)).toBe(false);
  });

  it('keeps the first trash time', async () => {
    const { store, query } = pool();
    await store.markTrashed('moonray', 'a@x.com');
    expect(args(query)[0]).toMatch(/COALESCE\(trashed_at, now\(\)\)/);
  });
});
