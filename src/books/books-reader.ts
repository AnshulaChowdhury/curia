// books-reader.ts — what the books specialist (agents/books.yaml) may read, and nothing it may change.
//
// A read-only facade over the stores the Books page and the Morning Brief already use. It exposes no method that approves a
// row, posts to QuickBooks, uploads or removes a file, edits a rule, or touches the vault: the specialist is read-only by
// design (ADR-060), so the only way to add a write is to add a method here and change the ADR.
//
// QuickBooks is read through the one shared QboConnection, because QuickBooks rotates the refresh token on every refresh and
// only one refresher may exist per process (qbo-connection.ts).

import type { Logger } from '../logger.js';
import type { LatestBatchCounts, ReviewCard } from './batch-store.js';
import type { Balances, QboQueryPort } from './qbo-balances.js';
import type { RunFact } from './monitor-logic.js';
import type { UploadSummary } from './upload-store.js';
import { quickbooksBalances } from './qbo-balances.js';
import { QboAuthError } from '../quickbooks/qbo-connection.js';

export type { ReviewCard } from './batch-store.js';

export interface BooksReaderDeps {
  batches: { latestBatchCounts(): Promise<LatestBatchCounts | null>; reviewCount(): Promise<number>; reviewCards(limit?: number): Promise<ReviewCard[]> };
  uploads: { list(limit?: number): Promise<UploadSummary[]>; listWaiting(): Promise<unknown[]> };
  monitor: {
    lastRun(): Promise<RunFact | null>;
    getHeartbeat(): Promise<{ lastSeenAt: Date; state: string | null; version: string | null } | null>;
  };
  /** The shared QuickBooks connection; null when QuickBooks is not set up. */
  qbo: QboQueryPort | null;
  logger: Logger;
  now?: () => Date;
}

export interface BooksSummary {
  quickbooks: { connected: boolean; balances: Balances | null; note: string | null };
  latestBatch: LatestBatchCounts | null;
  needsReview: number;
  filesWaiting: number;
  lastRun: { receivedAt: string | null; status: string | null; accountsReceived: string[]; expectedAccounts: string[] } | null;
  macMini: { lastSeenAt: string | null; minutesSinceCheckIn: number | null; state: string | null };
}

const ISO = (d: Date | undefined | null): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

export class BooksReader {
  private readonly now: () => Date;

  constructor(private readonly deps: BooksReaderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The state of the books in one object. A part that cannot be read is reported as such, never guessed. */
  async summary(): Promise<BooksSummary> {
    const { batches, uploads, monitor, qbo, logger } = this.deps;

    let quickbooks: BooksSummary['quickbooks'] = { connected: false, balances: null, note: 'QuickBooks is not set up' };
    if (qbo) {
      try {
        quickbooks = { connected: true, balances: await quickbooksBalances(qbo), note: null };
      } catch (err) {
        logger.warn({ err }, 'books reader: QuickBooks balances unavailable');
        quickbooks = {
          connected: !(err instanceof QboAuthError),
          balances: null,
          note: err instanceof QboAuthError ? 'QuickBooks is not connected: the owner has to press Connect again' : 'QuickBooks could not be read just now',
        };
      }
    }

    const [latestBatch, needsReview, waiting, run, beat] = await Promise.all([
      batches.latestBatchCounts(), batches.reviewCount(), uploads.listWaiting(), monitor.lastRun(), monitor.getHeartbeat(),
    ]);
    const seen = beat?.lastSeenAt ?? null;
    return {
      quickbooks,
      latestBatch,
      needsReview,
      filesWaiting: waiting.length,
      lastRun: run
        ? { receivedAt: ISO(run.receivedAt), status: run.status, accountsReceived: run.accountsReceived, expectedAccounts: run.expectedAccounts }
        : null,
      macMini: {
        lastSeenAt: ISO(seen),
        minutesSinceCheckIn: seen ? Math.max(0, Math.round((this.now().getTime() - seen.getTime()) / 60000)) : null,
        state: beat?.state ?? null,
      },
    };
  }

  /** The transactions waiting for the owner, as the Books page and the phone list them. */
  async reviewQueue(limit = 20): Promise<{ total: number; cards: ReviewCard[] }> {
    const n = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
    const [total, cards] = await Promise.all([this.deps.batches.reviewCount(), this.deps.batches.reviewCards(n)]);
    return { total, cards };
  }

  /** Recent bank-file uploads and what became of each. File contents are never returned. */
  async recentUploads(limit = 10): Promise<UploadSummary[]> {
    const n = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 10;
    return this.deps.uploads.list(n);
  }
}
