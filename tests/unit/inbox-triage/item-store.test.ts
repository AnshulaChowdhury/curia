import { describe, expect, it, vi } from 'vitest';
import { PgTriageStore } from '../../../src/inbox-triage/item-store.js';
import type { DbPool } from '../../../src/db/connection.js';

const cand = { accountId: 'moonray', messageId: 'm:1', threadId: 't', from: 'Dana', fromAddress: 'dana@example.com', subject: 'Hi', snippet: 'x'.repeat(500), receivedAt: 100 };
const pool = (rows: unknown[] = [], rowCount = 1) => {
  const query = vi.fn(async (..._a: unknown[]) => ({ rows, rowCount }));
  return { store: new PgTriageStore({ query } as unknown as DbPool), query };
};
const args = (q: ReturnType<typeof vi.fn>, n = 0) => q.mock.calls[n] as unknown as [string, unknown[]];

describe('PgTriageStore', () => {
  it('splits keys at the first colon, so message ids may contain one', async () => {
    const { store, query } = pool([{ x: 1 }]);
    expect(await store.has('moonray:m:1')).toBe(true);
    expect(args(query)[1]).toEqual(['moonray', 'm:1']);
    await store.add('moonray:m:1');
    expect(args(query, 1)[0]).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('says a message is unknown when there is no row', async () => {
    expect(await pool([]).store.has('moonray:m1')).toBe(false);
  });

  it('keeps sender, subject and a capped preview only for unsorted mail', async () => {
    const none = pool();
    await none.store.record(cand, 'none');
    const kept = args(none.query)[1];
    expect(kept.slice(0, 7)).toEqual(['moonray', 'm:1', 'none', 't', 'Dana', 'Hi', 'x'.repeat(300)]);
    expect(kept[8]).toBe('dana@example.com');

    const tagged = pool();
    await tagged.store.record(cand, 'tagged');
    expect(args(tagged.query)[1].slice(0, 7)).toEqual(['moonray', 'm:1', 'tagged', null, null, null, null]);
    expect(args(tagged.query)[1][8]).toBeNull();
  });

  it('reads unsorted mail back as items', async () => {
    const row = { account_id: 'moonray', message_id: 'm1', thread_id: 't', sender: 'Dana', sender_address: 'dana@example.com', subject: 'Hi', snippet: 's', received_at: new Date('2026-11-02T10:00:00Z'), outcome: 'failed' };
    const { store } = pool([row]);
    expect(await store.listUnsorted(10)).toEqual([
      { accountId: 'moonray', messageId: 'm1', threadId: 't', from: 'Dana', fromAddress: 'dana@example.com', subject: 'Hi', snippet: 's', receivedAt: '2026-11-02T10:00:00.000Z', reason: 'failed' },
    ]);
  });

  it('resolves only mail that is still waiting and drops its stored text', async () => {
    const { store, query } = pool([], 1);
    expect(await store.resolve('moonray', 'm1', 'seen')).toBe(true);
    expect(args(query)[0]).toMatch(/sender = NULL, sender_address = NULL, subject = NULL, snippet = NULL/);
    expect(args(query)[0]).toMatch(/outcome IN \('none', 'failed'\)/);
    expect(await pool([], 0).store.resolve('moonray', 'm1', 'seen')).toBe(false);
  });
});
