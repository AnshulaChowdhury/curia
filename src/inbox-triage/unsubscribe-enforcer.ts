// unsubscribe-enforcer.ts — what happens when a newsletter the owner unsubscribed from keeps arriving.
//
// The watcher asks this before classifying each new email. If its sender was unsubscribed through Curia:
//   - for the first 10 days nothing special happens (senders have that long to honour a request, CASL);
//   - after that, each new email from the sender makes Curia repeat the one-click unsubscribe request, at most three times,
//     with at least 3 days between tries so a batch of mail sent together does not use them all up;
//   - when the sender still mails after the third retry (and 3 more days), that mail is labelled "Likely spam" and moved to
//     Trash, the sender is saved as spam so the classifier learns it, and every later mail from it goes straight to Trash.
// Trash is the only delete-like action Curia takes on mail, and only here. Gmail keeps trashed mail for 30 days.
// The From address is not verified, so this can only ever move mail from a sender the owner already unsubscribed from.

import type { Logger } from '../logger.js';
import { oneClickTarget, parseListUnsubscribe, postOneClick, type OneClickResult } from '../phone-inbox/unsubscribe.js';
import type { UnsubscribeHeaders } from '../phone-inbox/nylas-unsubscribe.js';
import type { PgPreferenceStore } from './preference-store.js';
import { addressParts } from './preference-store.js';
import type { TriageCandidate, TriageGroup } from './types.js';
import type { UnsubscribeRecord } from './unsubscribe-store.js';

export const GRACE_DAYS = 10;
export const RETRY_SPACING_DAYS = 3;
export const MAX_RETRIES = 3;
const DAY_MS = 86_400_000;

export type EnforcerAction = 'wait' | 'retry' | 'trash';

/** What to do about a new email from a sender with this record. Pure. */
export function decide(record: UnsubscribeRecord, now: number): EnforcerAction {
  if (record.trashedAt) return 'trash';
  const since = (record.lastAttemptAt ?? record.unsubscribedAt).getTime();
  const wait = (record.lastAttemptAt ? RETRY_SPACING_DAYS : GRACE_DAYS) * DAY_MS;
  if (now - since < wait) return 'wait';
  return record.attempts < MAX_RETRIES ? 'retry' : 'trash';
}

/** The mailbox actions this needs. Trash is optional: a source without it can only retry. */
export interface EnforcerSource {
  applyLabel(messageId: string, group: TriageGroup): Promise<void>;
  moveToTrash?(messageId: string): Promise<void>;
}

export interface UnsubscribeEnforcerDeps {
  logger: Logger;
  store: {
    get(accountId: string, senderAddress: string): Promise<UnsubscribeRecord | null>;
    countAttempt(accountId: string, senderAddress: string, expected: number): Promise<boolean>;
    markTrashed(accountId: string, senderAddress: string): Promise<void>;
  };
  preferences: Pick<PgPreferenceStore, 'save'>;
  /** Reads the new email's unsubscribe headers; null when the mailbox is not connected or the email is gone. */
  readHeaders: (accountId: string, messageId: string) => Promise<UnsubscribeHeaders | null>;
  oneClick?: (url: URL) => Promise<OneClickResult>;
  now?: () => number;
}

/** 'handled' = the mail was dealt with (trashed): skip classification. 'continue' = classify it as usual. */
export type EnforcerResult = 'handled' | 'continue';

export class UnsubscribeEnforcer {
  constructor(private readonly deps: UnsubscribeEnforcerDeps) {}

  async check(candidate: TriageCandidate, source: EnforcerSource): Promise<EnforcerResult> {
    const { store, now = Date.now } = this.deps;
    const parts = candidate.fromAddress ? addressParts(candidate.fromAddress) : null;
    if (!parts) return 'continue';
    const record = await store.get(candidate.accountId, parts.address);
    if (!record) return 'continue';

    const action = decide(record, now());
    if (action === 'wait') return 'continue';
    if (action === 'retry') {
      await this.retry(candidate, parts.address, record.attempts);
      return 'continue';
    }
    return (await this.trash(candidate, parts.address, source)) ? 'handled' : 'continue';
  }

  private async retry(candidate: TriageCandidate, sender: string, attempts: number): Promise<void> {
    const { store, logger, readHeaders, oneClick = (url) => postOneClick(url) } = this.deps;
    // Counted before the request, so a crash or a failure can never turn into an endless loop of tries.
    if (!(await store.countAttempt(candidate.accountId, sender, attempts))) return;
    const headers = await readHeaders(candidate.accountId, candidate.messageId);
    const unsub = parseListUnsubscribe(headers?.listUnsubscribe, headers?.listUnsubscribePost);
    const target = unsub.oneClick && unsub.links[0] ? oneClickTarget(unsub.links[0]) : null;
    if (!target) {
      logger.warn({ accountId: candidate.accountId, attempt: attempts + 1 }, 'inbox-triage: unsubscribe retry skipped (no usable one-click link in the new email)');
      return;
    }
    const outcome = await oneClick(target);
    logger.info(
      { accountId: candidate.accountId, host: target.hostname, attempt: attempts + 1, ok: outcome.ok, status: outcome.status },
      'inbox-triage: unsubscribe retried (the sender kept mailing)',
    );
  }

  private async trash(candidate: TriageCandidate, sender: string, source: EnforcerSource): Promise<boolean> {
    const { store, preferences, logger } = this.deps;
    if (!source.moveToTrash) return false;
    try {
      await source.applyLabel(candidate.messageId, 'spam'); // labelled and marked read; the label stays on the trashed copy
    } catch (err) {
      logger.warn({ err, accountId: candidate.accountId }, 'inbox-triage: could not label unsubscribed mail as spam');
      return false;
    }
    try {
      await source.moveToTrash(candidate.messageId);
    } catch (err) {
      logger.warn({ err, accountId: candidate.accountId }, 'inbox-triage: could not move unsubscribed mail to Trash');
      return true; // already labelled spam and marked read; the next mail from the sender tries Trash again
    }
    await store.markTrashed(candidate.accountId, sender);
    try {
      await preferences.save({ accountId: candidate.accountId, scope: 'sender', value: sender, group: 'spam' });
    } catch (err) {
      logger.warn({ err }, 'inbox-triage: could not save the sender as spam');
    }
    logger.info({ accountId: candidate.accountId, domain: sender.split('@')[1] }, 'inbox-triage: mail from an unsubscribed sender moved to Trash');
    return true;
  }
}
