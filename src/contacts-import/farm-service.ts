// farm-service.ts — reads one mailbox, ten years back, in the background, into counts (see farm-reduce.ts).
//
// A scan is a loop over Nylas pages. After each page its counts and the next cursor are committed together, so a scan
// that stops (a deploy, a rate limit, an error) is resumed from its cursor and never double counts. One scan per
// mailbox at a time. Progress is the run row; nothing about a message other than the counts is kept.

import type { Logger } from '../logger.js';
import { MailboxRateLimitedError } from '../phone-inbox/phone-inbox-service.js';
import type { NylasMailbox } from '../phone-inbox/nylas-mailbox.js';
import { ignoredFolderIds, reduceMessages } from './farm-reduce.js';
import type { FarmRun, FarmStore } from './farm-store.js';

export const FARM_YEARS = 10;
const MAX_RATE_LIMIT_WAITS = 20;
const MAX_WAIT_SECONDS = 120;

export interface FarmTarget {
  accountId: string;
  address: string | null;
  mailbox: Pick<NylasMailbox, 'scanPage' | 'folderNames'>;
}

export class MailboxFarmService {
  private readonly active = new Set<string>();

  constructor(
    private readonly store: FarmStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  isRunning(accountId: string): boolean {
    return this.active.has(accountId);
  }

  /** Starts (or resumes) the scan and returns at once; the scan keeps going in the background. */
  async start(target: FarmTarget, opts: { resume: boolean }): Promise<FarmRun> {
    if (this.active.has(target.accountId)) throw new Error('already_running');
    const windowStart = new Date(this.now() - FARM_YEARS * 365.25 * 24 * 3600 * 1000);
    const run = await this.store.startRun(target.accountId, windowStart, opts.resume);
    this.active.add(target.accountId);
    void this.loop(target, run).catch((err) => this.logger.error({ accountId: target.accountId, errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-farm: scan crashed'));
    return run;
  }

  /** Runs the scan to the end; exposed so tests can await it. */
  async loop(target: FarmTarget, run: FarmRun): Promise<void> {
    const { accountId } = target;
    try {
      const ignored = ignoredFolderIds(await target.mailbox.folderNames());
      const after = Math.floor(Date.parse(run.windowStart) / 1000);
      let cursor = run.cursor ?? undefined;
      let waits = 0;
      for (;;) {
        let page;
        try {
          page = await target.mailbox.scanPage(after, cursor);
        } catch (err) {
          if (err instanceof MailboxRateLimitedError && waits < MAX_RATE_LIMIT_WAITS) {
            waits += 1;
            this.logger.info({ accountId, wait: waits, retryAfterSeconds: err.retryAfterSeconds ?? null, detail: err.detail ?? null }, 'contacts-farm: rate limited, waiting');
            await this.sleep(Math.min(err.retryAfterSeconds ?? 30, MAX_WAIT_SECONDS) * 1000);
            continue;
          }
          const kind = err instanceof MailboxRateLimitedError ? 'rate_limited' : err instanceof Error ? err.name : 'unknown';
          await this.store.finish(accountId, kind === 'rate_limited' ? 'paused' : 'failed', kind);
          this.logger.warn({ accountId, kind }, 'contacts-farm: scan stopped; it can be resumed');
          return;
        }
        const deltas = [...reduceMessages(page.messages, target.address, ignored).values()];
        await this.store.commitPage(accountId, page.nextCursor ?? null, page.messages.length, deltas);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      await this.store.finish(accountId, 'done');
      this.logger.info({ accountId }, 'contacts-farm: scan finished');
    } finally {
      this.active.delete(accountId);
    }
  }
}
