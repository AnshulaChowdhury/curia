// watcher.ts — polls each mailbox for new unread, untagged mail, classifies it, labels it and pushes (FR-ETW).
//
// The watcher itself makes no model calls: classification goes through the injected Classifier. A failure
// anywhere is logged and skipped. The 15-minute ceo-inbox sweep still sees the mail, so nothing is lost.

import type { Logger } from '../logger.js';
import { isPushGroup, type PushGroup, type TriageCandidate, type TriageGroup, type TriageVerdict } from './types.js';

/** One connected mailbox. Reads untagged unread mail; writes only the triage label (FR-ETW-5). */
export interface TriageSource {
  readonly accountId: string;
  listUntagged(): Promise<TriageCandidate[]>;
  applyLabel(messageId: string, group: TriageGroup): Promise<void>;
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
  logger: Logger;
  intervalMs: number;
  /** Most messages classified per tick, per account. Bounds cost if a backlog appears. */
  maxPerTick?: number;
}

const DEFAULT_MAX_PER_TICK = 5;

export class InboxWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

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
    let candidates: TriageCandidate[];
    try {
      candidates = await source.listUntagged();
    } catch (err) {
      // FR-ETW-3: retry on the next tick; the sweep covers the gap.
      logger.warn({ err, accountId: source.accountId }, 'inbox-triage: could not list new mail');
      return;
    }

    const limit = this.config.maxPerTick ?? DEFAULT_MAX_PER_TICK;
    let handled = 0;
    // Oldest first, like the sweep.
    for (const candidate of [...candidates].sort((a, b) => a.receivedAt - b.receivedAt)) {
      if (handled >= limit) break;
      const key = `${candidate.accountId}:${candidate.messageId}`;
      if (await seen.has(key)) continue;
      // Marked before classifying (FR-ETW-2): a crash mid-call must not loop on one message.
      await seen.add(key);
      handled += 1;

      let verdict: TriageVerdict;
      try {
        verdict = await classifier.classify(candidate);
      } catch (err) {
        logger.warn({ err, accountId: candidate.accountId, messageId: candidate.messageId }, 'inbox-triage: classification failed');
        continue;
      }
      if (verdict.group === 'none') continue;

      try {
        await source.applyLabel(candidate.messageId, verdict.group);
      } catch (err) {
        logger.warn({ err, accountId: candidate.accountId, messageId: candidate.messageId }, 'inbox-triage: could not apply the label');
        continue;
      }
      logger.info(
        { accountId: candidate.accountId, group: verdict.group, confidence: verdict.confidence, unsure: verdict.unsure },
        'inbox-triage: message tagged',
      );

      // Newsletter and spam are labelled and marked read, never pushed.
      if (!isPushGroup(verdict.group)) continue;
      try {
        await notifier.notify(verdict.group);
      } catch (err) {
        // FR-ETP-3: a push failure never blocks tagging.
        logger.warn({ err, group: verdict.group }, 'inbox-triage: push failed');
      }
    }
  }
}
