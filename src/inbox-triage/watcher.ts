// watcher.ts — polls each mailbox for new unread, untagged mail, classifies it, labels it and pushes (FR-ETW).
//
// The watcher itself makes no model calls: classification goes through the injected Classifier. A failure
// anywhere is logged and skipped. The 15-minute ceo-inbox sweep still sees the mail, so nothing is lost.

import type { Logger } from '../logger.js';
import { MailboxRateLimitedError } from '../phone-inbox/phone-inbox-service.js';
import type { OutcomeRecorder, TriageOutcome } from './item-store.js';
import { isPushGroup, type PushGroup, type TriageCandidate, type TriageGroup, type TriageVerdict } from './types.js';

/** One connected mailbox. Reads untagged unread mail; writes only the triage label (FR-ETW-5). */
export interface TriageSource {
  readonly accountId: string;
  /** Untagged mail in the triage window, read or unread. `isKnown` lets the source skip mail already handled. */
  listUntagged(isKnown?: (messageId: string) => Promise<boolean>): Promise<TriageCandidate[]>;
  applyLabel(messageId: string, group: TriageGroup): Promise<void>;
  /** Moves a message to Trash. Optional; used only by the unsubscribe follow-up, never by classification. */
  moveToTrash?(messageId: string): Promise<void>;
  /** Told after each pass whether every message in the listing was handled; a source that keeps a progress mark saves it then. */
  commitProgress?(allHandled: boolean): Promise<void>;
}

export interface Classifier {
  classify(candidate: TriageCandidate): Promise<TriageVerdict>;
}

export interface TriageNotifier {
  notify(group: PushGroup): Promise<void>;
}

/** Remembers which messages were already classified, so a restart or an overlapping poll never repeats one. */
export interface SeenStore {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}

export interface InboxWatcherConfig {
  sources: TriageSource[];
  classifier: Classifier;
  notifier: TriageNotifier;
  seen: SeenStore;
  /** Told how each message ended, so unsorted mail can be reviewed from the phone. Optional. */
  outcomes?: OutcomeRecorder;
  logger: Logger;
  intervalMs: number;
  /** Asked before each message is classified. 'handled' skips classification (the mail was dealt with). Optional. */
  beforeClassify?: (candidate: TriageCandidate, source: TriageSource) => Promise<'handled' | 'continue'>;
  /** Most messages classified per tick, per account. Bounds cost if a backlog appears. */
  maxPerTick?: number;
}

const DEFAULT_MAX_PER_TICK = 5;
const DEFAULT_COOLDOWN_SECONDS = 300;
/** Repeated rate limits double the pause each time, up to this. */
const MAX_COOLDOWN_SECONDS = 1800;

export class InboxWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Per mailbox: when a rate-limited mailbox may be asked again. */
  private readonly blockedUntil = new Map<string, number>();
  /** Per mailbox: rate limits in a row, so the pause can grow while Google keeps refusing. */
  private readonly rateLimitStreak = new Map<string, number>();

  constructor(private readonly config: InboxWatcherConfig) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.config.logger.error({ err }, 'inbox-triage: unhandled error in tick');
      });
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every account. Overlapping passes are skipped. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const source of this.config.sources) {
        await this.tickSource(source);
      }
    } finally {
      this.running = false;
    }
  }

  private async tickSource(source: TriageSource): Promise<void> {
    const { logger, seen, classifier, notifier } = this.config;
    if ((this.blockedUntil.get(source.accountId) ?? 0) > Date.now()) return; // cooling down after a rate limit
    let candidates: TriageCandidate[];
    try {
      candidates = await source.listUntagged((messageId) => seen.has(`${source.accountId}:${messageId}`));
    } catch (err) {
      if (err instanceof MailboxRateLimitedError) {
        // Leave the mailbox alone for a while: hammering a rate-limited Google account only prolongs it.
        const streak = (this.rateLimitStreak.get(source.accountId) ?? 0) + 1;
        this.rateLimitStreak.set(source.accountId, streak);
        const waitSeconds = err.retryAfterSeconds ?? Math.min(DEFAULT_COOLDOWN_SECONDS * 2 ** (streak - 1), MAX_COOLDOWN_SECONDS);
        this.blockedUntil.set(source.accountId, Date.now() + waitSeconds * 1000);
        logger.warn({ accountId: source.accountId, waitSeconds, streak }, 'inbox-triage: mailbox rate-limited, pausing it');
        return;
      }
      // FR-ETW-3: retry on the next tick; the sweep covers the gap.
      logger.warn({ err, accountId: source.accountId }, 'inbox-triage: could not list new mail');
      return;
    }

    this.rateLimitStreak.delete(source.accountId);
    const limit = this.config.maxPerTick ?? DEFAULT_MAX_PER_TICK;
    let handled = 0;
    let allHandled = true;
    // Oldest first, like the sweep.
    for (const candidate of [...candidates].sort((a, b) => a.receivedAt - b.receivedAt)) {
      if (handled >= limit) {
        allHandled = false; // more waiting than one pass may take; the next listing starts from the same place
        break;
      }
      const key = `${candidate.accountId}:${candidate.messageId}`;
      if (await seen.has(key)) continue;
      // Marked before classifying (FR-ETW-2): a crash mid-call must not loop on one message.
      await seen.add(key);
      handled += 1;

      if (this.config.beforeClassify) {
        let result: 'handled' | 'continue' = 'continue';
        try {
          result = await this.config.beforeClassify(candidate, source);
        } catch (err) {
          // A failure here must never stop the mail being classified.
          logger.warn({ err, accountId: candidate.accountId }, 'inbox-triage: pre-classification check failed');
        }
        if (result === 'handled') {
          await this.report(candidate, 'tagged');
          continue;
        }
      }

      let verdict: TriageVerdict;
      try {
        verdict = await classifier.classify(candidate);
      } catch (err) {
        logger.warn({ err, accountId: candidate.accountId, messageId: candidate.messageId }, 'inbox-triage: classification failed');
        await this.report(candidate, 'failed');
        continue;
      }
      if (verdict.group === 'none') {
        await this.report(candidate, 'none');
        continue;
      }

      try {
        await source.applyLabel(candidate.messageId, verdict.group);
      } catch (err) {
        logger.warn({ err, accountId: candidate.accountId, messageId: candidate.messageId }, 'inbox-triage: could not apply the label');
        await this.report(candidate, 'failed');
        continue;
      }
      await this.report(candidate, 'tagged');
      logger.info(
        { accountId: candidate.accountId, group: verdict.group, confidence: verdict.confidence, unsure: verdict.unsure },
        'inbox-triage: message tagged',
      );

      // Newsletter and spam are labelled and marked read, never pushed.
      if (!isPushGroup(verdict.group)) continue;
      // Mail the owner already read is labelled but never wakes the phone.
      if (candidate.unread === false) continue;
      try {
        await notifier.notify(verdict.group);
      } catch (err) {
        // FR-ETP-3: a push failure never blocks tagging.
        logger.warn({ err, group: verdict.group }, 'inbox-triage: push failed');
      }
    }

    if (source.commitProgress) {
      try {
        await source.commitProgress(allHandled);
      } catch (err) {
        // The mark is only a resume point: if it is not saved, the next pass simply starts a little earlier.
        logger.warn({ err, accountId: source.accountId }, 'inbox-triage: could not save the triage progress');
      }
    }
  }

  /** Tells the recorder how a message ended. A recorder failure is logged and never stops the pass. */
  private async report(candidate: TriageCandidate, outcome: TriageOutcome): Promise<void> {
    const { outcomes, logger } = this.config;
    if (!outcomes) return;
    try {
      await outcomes.record(candidate, outcome);
    } catch (err) {
      logger.warn({ err, accountId: candidate.accountId, messageId: candidate.messageId, outcome }, 'inbox-triage: could not record the outcome');
    }
  }
}
