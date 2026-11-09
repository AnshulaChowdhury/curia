import { describe, expect, it, vi } from 'vitest';
import { PgTriageProgressStore } from '../../../src/inbox-triage/progress-store.js';
import type { DbPool } from '../../../src/db/connection.js';

const pool = (rows: unknown[] = []) => {
  const query = vi.fn(async (..._a: unknown[]) => ({ rows, rowCount: rows.length }));
  return { store: new PgTriageProgressStore({ query } as unknown as DbPool), query };
};

describe('PgTriageProgressStore', () => {
  it('reads the saved time back in milliseconds, or null when there is none', async () => {
    expect(await pool([{ ms: '1793893682254' }]).store.get('moonray')).toBe(1793893682254);
    expect(await pool([]).store.get('moonray')).toBeNull();
  });

  it('saves a time without ever moving the mark backwards', async () => {
    const { store, query } = pool();
    await store.set('moonray', 1793893682254);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/GREATEST\(inbox_triage_progress\.last_success_at, EXCLUDED\.last_success_at\)/);
    expect(params).toEqual(['moonray', 1793893682254]);
  });
});
