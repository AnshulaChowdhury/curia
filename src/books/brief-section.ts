// brief-section.ts — the "Accounting update" section of the Morning Brief (GET /phone/brief).
//
// Five plain lines, nothing invented: cash in bank, liabilities, accounts receivable (all from QuickBooks), the number of
// transactions in the latest RBC files, and how many of them are matched to an entry in QuickBooks. If transactions
// need the owner, the section also points at the details page (GET /phone/books/review) with how many.
//
// A plain function so whichever route assembles the brief can call it and drop the section when it returns null.

import type { Logger } from '../logger.js';
import type { LatestBatchCounts } from './batch-store.js';
import { quickbooksBalances, type Balances } from './qbo-balances.js';
import { QboAuthError } from '../quickbooks/qbo-connection.js';

export interface BriefItem {
  text: string;
}

export interface BriefDetails {
  /** Phone-token route that returns the cards. */
  path: string;
  title: string;
  count: number;
}

export interface AccountingBrief {
  items: BriefItem[];
  details: BriefDetails | null;
}

export interface AccountingBriefDeps {
  batches: { latestBatchCounts(): Promise<LatestBatchCounts | null>; reviewCount(): Promise<number> };
  balances: { get(): Promise<Balances> };
  logger: Logger;
}

export const REVIEW_PATH = '/phone/books/review';

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/** The accounting section for today's brief, or null when there is nothing to show. */
export async function accountingBrief(deps: AccountingBriefDeps): Promise<AccountingBrief | null> {
  const items: BriefItem[] = [];

  try {
    const b = await deps.balances.get();
    items.push({ text: `Cash in bank: ${money.format(b.cash)}` }, { text: `Liabilities: ${money.format(b.liabilities)}` }, { text: `Accounts receivable: ${money.format(b.receivable)}` });
  } catch (err) {
    // The balances are the point of the section: say so rather than silently dropping them.
    deps.logger.warn({ err }, 'brief: QuickBooks balances unavailable');
    items.push({ text: err instanceof QboAuthError ? 'QuickBooks is not connected' : 'QuickBooks figures are unavailable right now' });
  }

  let reviewCount = 0;
  try {
    const latest = await deps.batches.latestBatchCounts();
    if (latest) {
      items.push({ text: `Transactions in RBC (latest files): ${latest.total}` }, { text: `Matched in QuickBooks: ${latest.matched}` });
    }
    reviewCount = await deps.batches.reviewCount();
  } catch (err) {
    deps.logger.warn({ err }, 'brief: books batches unavailable');
  }

  if (items.length === 0 && reviewCount === 0) return null;
  return { items, details: reviewCount > 0 ? { path: REVIEW_PATH, title: 'Transactions to review', count: reviewCount } : null };
}

/** Wires the section to the real stores: what the brief route calls once a day. */
export function accountingBriefProvider(parts: {
  batches: AccountingBriefDeps['batches'];
  qbo: { api: (method: 'GET' | 'POST', path: string, params?: Record<string, string>, body?: unknown) => Promise<unknown> };
  logger: Logger;
}): () => Promise<AccountingBrief | null> {
  return () => accountingBrief({ batches: parts.batches, balances: { get: () => quickbooksBalances(parts.qbo) }, logger: parts.logger });
}
