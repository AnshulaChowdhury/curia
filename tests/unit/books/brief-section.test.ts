import { describe, it, expect } from 'vitest';
import { accountingBrief, accountingBriefProvider, REVIEW_PATH, type AccountingBriefDeps } from '../../../src/books/brief-section.js';
import type { LatestBatchCounts } from '../../../src/books/batch-store.js';
import type { Balances } from '../../../src/books/qbo-balances.js';
import { QboAuthError } from '../../../src/quickbooks/qbo-connection.js';
import { createSilentLogger } from '../../../src/logger.js';

const BALANCES: Balances = { cash: 12345.67, liabilities: 3210, receivable: 1500.5 };
const LATEST: LatestBatchCounts = { batchId: 'abc', createdAt: '2026-11-02T10:00:00Z', total: 64, matched: 58 };

function deps(over: { balances?: Balances | Error; latest?: LatestBatchCounts | null | Error; review?: number | Error } = {}): AccountingBriefDeps {
  const settle = <T,>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    balances: { get: () => settle(over.balances ?? BALANCES) },
    batches: {
      latestBatchCounts: () => settle(over.latest === undefined ? LATEST : over.latest),
      reviewCount: () => settle(over.review ?? 0),
    },
    logger: createSilentLogger(),
  };
}

describe('accountingBrief', () => {
  it('is exactly the five lines the owner asked for', async () => {
    const b = await accountingBrief(deps());
    expect(b!.items.map(i => i.text)).toEqual([
      'Cash in bank: $12,345.67',
      'Liabilities: $3,210.00',
      'Accounts receivable: $1,500.50',
      'Transactions in RBC (latest files): 64',
      'Matched in QuickBooks: 58',
    ]);
    expect(b!.details).toBeNull();
  });

  it('points at the details page, with how many, only when transactions need review', async () => {
    const b = await accountingBrief(deps({ review: 3 }));
    expect(b!.details).toEqual({ path: REVIEW_PATH, title: 'Transactions to review', count: 3 });
    expect(REVIEW_PATH).toBe('/phone/books/review');
  });

  it('formats a negative balance and zero sensibly', async () => {
    const b = await accountingBrief(deps({ balances: { cash: -50.25, liabilities: 0, receivable: 0 } }));
    expect(b!.items[0]!.text).toMatch(/^Cash in bank: -\$50\.25$/);
    expect(b!.items[1]!.text).toBe('Liabilities: $0.00');
  });

  it('says so when QuickBooks is not connected, or its figures are unavailable, instead of leaving the figures out silently', async () => {
    const notConnected = await accountingBrief(deps({ balances: new QboAuthError('press Connect again') }));
    expect(notConnected!.items[0]!.text).toBe('QuickBooks is not connected');
    expect(notConnected!.items).toHaveLength(3);                       // the RBC lines still show
    const down = await accountingBrief(deps({ balances: new Error('boom') }));
    expect(down!.items[0]!.text).toBe('QuickBooks figures are unavailable right now');
  });

  it('leaves out the RBC lines before any bank file has been processed', async () => {
    const b = await accountingBrief(deps({ latest: null }));
    expect(b!.items.map(i => i.text)).toEqual(['Cash in bank: $12,345.67', 'Liabilities: $3,210.00', 'Accounts receivable: $1,500.50']);
  });

  it('keeps the balances when the books tables fail, and has nothing to say when everything is empty', async () => {
    const b = await accountingBrief(deps({ latest: new Error('db down') }));
    expect(b!.items).toHaveLength(3);
    // QuickBooks down AND nothing in the books still produces the one explanatory line
    const x = await accountingBrief(deps({ balances: new Error('x'), latest: null }));
    expect(x!.items.map(i => i.text)).toEqual(['QuickBooks figures are unavailable right now']);
  });

  it('is built from the real stores by the provider', async () => {
    const qbo = {
      api: async () => ({ QueryResponse: { Account: [{ AccountType: 'Bank', CurrentBalance: 10 }, { AccountType: 'Credit Card', CurrentBalance: 4 }, { AccountType: 'Accounts Receivable', CurrentBalance: 2 }] } }),
    };
    const run = accountingBriefProvider({ batches: deps().batches, qbo, logger: createSilentLogger() });
    expect((await run())!.items.slice(0, 3).map(i => i.text)).toEqual(['Cash in bank: $10.00', 'Liabilities: $4.00', 'Accounts receivable: $2.00']);
  });

  it('never shows an account number', async () => {
    const b = await accountingBrief(deps());
    expect(b!.items.map(i => i.text).join(' ')).not.toMatch(/4530|9956/);
  });
});
