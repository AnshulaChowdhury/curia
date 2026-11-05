import { describe, expect, it } from 'vitest';
import { UnsortedBriefSource } from '../../../src/phone-brief/unsorted-source.js';
import type { UnsortedItem } from '../../../src/inbox-triage/item-store.js';

const item = (n: number, reason: UnsortedItem['reason'] = 'none'): UnsortedItem =>
  ({ accountId: 'moonray', messageId: `m${n}`, threadId: '', from: `Sender ${n}`, fromAddress: '', subject: `Subject ${n}`, snippet: '', receivedAt: null, reason });

describe('UnsortedBriefSource', () => {
  it('has no section when nothing is waiting', async () => {
    const source = new UnsortedBriefSource({ listUnsorted: async () => [], countUnsorted: async () => 0 });
    expect(await source.items()).toEqual([]);
  });

  it('lists each email with sender, subject and why it is here', async () => {
    const source = new UnsortedBriefSource({ listUnsorted: async () => [item(1), item(2, 'failed')], countUnsorted: async () => 2 });
    const items = await source.items();
    expect(items.map((i) => [i.from, i.subject])).toEqual([['Sender 1', 'Subject 1'], ['Sender 2', 'Subject 2']]);
    expect(items[0]!.text).toMatch(/Did not fit a category/);
    expect(items[1]!.text).toMatch(/Could not be sorted/);
  });

  it('says how many are waiting when more than fit in the brief', async () => {
    const source = new UnsortedBriefSource({ listUnsorted: async () => [item(1), item(2)], countUnsorted: async () => 37 });
    expect((await source.items())[0]!.text).toMatch(/37 emails are waiting/);
  });
});
