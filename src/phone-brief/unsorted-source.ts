// unsorted-source.ts — the "unsorted" section: mail triage could not sort, waiting for the owner to pick a category.
//
// One item per email (sender and subject, plus why it is here). The cards with the category buttons come from
// GET /phone/triage/review; the brief only tells the owner that they are there. Nothing is read from the mailbox.

import type { PgTriageStore } from '../inbox-triage/item-store.js';
import { MAX_ITEMS_PER_SECTION, type BriefItem, type BriefSource } from './types.js';

export class UnsortedBriefSource implements BriefSource {
  readonly id = 'unsorted' as const;

  constructor(private readonly store: Pick<PgTriageStore, 'listUnsorted' | 'countUnsorted'>) {}

  async items(): Promise<BriefItem[]> {
    const waiting = await this.store.listUnsorted(MAX_ITEMS_PER_SECTION);
    if (waiting.length === 0) return [];
    const total = await this.store.countUnsorted();
    return waiting.map((m, i) => ({
      from: m.from,
      subject: m.subject,
      text: i === 0 && total > waiting.length
        ? `Not sorted automatically. ${total} emails are waiting for a category.`
        : m.reason === 'failed' ? 'Could not be sorted automatically. Pick a category.' : 'Did not fit a category. Pick one.',
    }));
  }
}
