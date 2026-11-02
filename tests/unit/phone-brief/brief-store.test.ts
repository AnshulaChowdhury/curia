import { describe, expect, it, vi } from 'vitest';
import { PgBriefStore } from '../../../src/phone-brief/brief-store.js';
import type { DbPool } from '../../../src/db/connection.js';

describe('PgBriefStore', () => {
  it('upserts by date with parameterised SQL, then prunes old days', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new PgBriefStore({ query } as unknown as DbPool).save({
      date: '2026-11-02', generatedAt: '2026-11-02T11:30:00.000Z', sections: [{ id: 'accounting', items: [{ text: 'x' }] }],
    });
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[0]![0]).toMatch(/INSERT INTO phone_briefs[\s\S]*ON CONFLICT \(brief_date\)/);
    expect(calls[0]![1]).toEqual(['2026-11-02', '2026-11-02T11:30:00.000Z', JSON.stringify({ sections: [{ id: 'accounting', items: [{ text: 'x' }] }] })]);
    expect(calls[1]![0]).toMatch(/DELETE FROM phone_briefs/);
    expect(calls[1]![1]).toEqual(['2026-11-02', 30]);
  });

  it('reads a stored day back, or null', async () => {
    const row = { brief_date: '2026-11-02', generated_at: new Date('2026-11-02T11:30:00Z'), payload: { sections: [{ id: 'contacts', items: [{ text: 'y' }] }] } };
    const store = new PgBriefStore({ query: vi.fn(async () => ({ rows: [row] })) } as unknown as DbPool);
    expect(await store.get('2026-11-02')).toEqual({ date: '2026-11-02', generatedAt: '2026-11-02T11:30:00.000Z', sections: [{ id: 'contacts', items: [{ text: 'y' }] }] });
    expect(await new PgBriefStore({ query: vi.fn(async () => ({ rows: [] })) } as unknown as DbPool).get('2026-11-03')).toBeNull();
  });
});
