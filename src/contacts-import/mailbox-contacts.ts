// mailbox-contacts.ts — turns a mailbox's farmed facts into import candidates, and decides which mailboxes may be farmed.

import { classifyEmailSender } from '../contacts/contact-service.js';
import type { MailboxCategoryStore, MailboxCategory } from '../phone-inbox/mailbox-category-store.js';
import { isPhoneInboxAccountId } from '../phone-inbox/mailbox-category-store.js';
import { NylasMailbox } from '../phone-inbox/nylas-mailbox.js';
import type { PhoneInboxAccountConfig } from '../phone-inbox/phone-inbox-service.js';
import type { FarmStore } from './farm-store.js';
import type { FarmTarget } from './farm-service.js';
import type { Candidate } from './merge.js';
import type { Collector } from './pull-service.js';

export const MAX_FARM_CANDIDATES = 50_000;

const LABEL: Record<MailboxCategory, 'work' | 'personal'> = { WORK: 'work', PERSONAL: 'personal' };

export type TargetResult =
  | { ok: true; target: FarmTarget; category: MailboxCategory }
  | { ok: false; reason: 'unknown_account' | 'skipped' | 'not_connected' | 'no_category' };

/** A mailbox is farmed only when its Nylas grant is connected and Command Hub has reported its category. Work Outlook is skipped. */
export async function resolveFarmTarget(
  accountId: string,
  mailboxes: PhoneInboxAccountConfig[],
  categories: Pick<MailboxCategoryStore, 'get'>,
): Promise<TargetResult> {
  if (!isPhoneInboxAccountId(accountId)) return { ok: false, reason: 'unknown_account' };
  if (accountId === 'work-outlook') return { ok: false, reason: 'skipped' };
  const box = mailboxes.find((m) => m.id === accountId);
  if (!box || !(box.reader instanceof NylasMailbox)) return { ok: false, reason: 'not_connected' };
  const reported = await categories.get(accountId);
  if (!reported) return { ok: false, reason: 'no_category' };
  return { ok: true, target: { accountId, address: box.address, mailbox: box.reader }, category: reported.category };
}

/** People only: automated senders were never stored, and role addresses (info@, sales@) are left for domain mining. */
export function farmCollector(accountId: string, label: string, category: MailboxCategory, store: FarmStore): Collector {
  return {
    sourceId: `mailbox:${accountId}`,
    label,
    async collect() {
      const run = await store.getRun(accountId);
      if (!run) return { ok: false, message: 'This mailbox has not been scanned yet. Start the scan first.', read: 0, candidates: [] };
      const facts = await store.facts(accountId, MAX_FARM_CANDIDATES);
      const candidates: Candidate[] = facts
        .filter((f) => classifyEmailSender(f.email) === 'person')
        .map((f) => ({
          sourceKey: `mailbox:${accountId}:${f.email}`,
          sourceId: `mailbox:${accountId}`,
          displayName: f.displayName ?? '',
          emails: [f.email],
          phones: [],
          label: LABEL[category],
        }));
      const note = run.status === 'done' ? 'Read.' : `Scan ${run.status}: results so far (${run.messagesScanned} messages).`;
      return { ok: run.status === 'done', message: note, read: facts.length, candidates };
    },
  };
}
