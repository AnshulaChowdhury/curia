import { describe, it, expect, vi } from 'vitest';
import { BooksReader, type BooksReaderDeps } from '../../../src/books/books-reader.js';
import { QboAuthError } from '../../../src/quickbooks/qbo-connection.js';
import { createSilentLogger } from '../../../src/logger.js';

const NOW = new Date('2026-11-03T15:00:00Z');

function build(over: Partial<BooksReaderDeps> = {}) {
  const deps: BooksReaderDeps = {
    batches: {
      latestBatchCounts: vi.fn().mockResolvedValue({ batchId: 'b1', createdAt: '2026-11-02T10:00:00Z', total: 40, matched: 31 }),
      reviewCount: vi.fn().mockResolvedValue(9),
      reviewCards: vi.fn().mockResolvedValue([{ id: 'r1', description: 'SHOPPERS' }]),
    },
    uploads: { list: vi.fn().mockResolvedValue([{ id: 'u1', name: 'a.qbo' }]), listWaiting: vi.fn().mockResolvedValue([{}, {}]) },
    monitor: {
      lastRun: vi.fn().mockResolvedValue({ receivedAt: new Date('2026-11-03T14:00:00Z'), status: 'ready', accountsReceived: ['rbc-chequing-4530'], expectedAccounts: ['rbc-chequing-4530', 'rbc-mastercard-9956'] }),
      getHeartbeat: vi.fn().mockResolvedValue({ lastSeenAt: new Date('2026-11-03T14:45:00Z'), state: 'idle', version: '1' }),
    },
    qbo: {
      api: vi.fn().mockResolvedValue({ QueryResponse: { Account: [
        { AccountType: 'Bank', CurrentBalance: 1000.5 }, { AccountType: 'Credit Card', CurrentBalance: 200 }, { AccountType: 'Accounts Receivable', CurrentBalance: 50 },
      ] } }),
    },
    logger: createSilentLogger(),
    now: () => NOW,
    ...over,
  };
  return { reader: new BooksReader(deps), deps };
}

describe('BooksReader.summary', () => {
  it('puts the books in one object', async () => {
    const s = await build().reader.summary();
    expect(s.quickbooks).toEqual({ connected: true, balances: { cash: 1000.5, liabilities: 200, receivable: 50 }, note: null });
    expect(s.latestBatch).toMatchObject({ total: 40, matched: 31 });
    expect(s).toMatchObject({ needsReview: 9, filesWaiting: 2 });
    expect(s.lastRun).toMatchObject({ status: 'ready', accountsReceived: ['rbc-chequing-4530'] });
    expect(s.macMini).toEqual({ lastSeenAt: '2026-11-03T14:45:00.000Z', minutesSinceCheckIn: 15, state: 'idle' });
  });

  it('says so, without guessing, when QuickBooks needs reconnecting', async () => {
    const { reader } = build({ qbo: { api: vi.fn().mockRejectedValue(new QboAuthError('expired')) } });
    const s = await reader.summary();
    expect(s.quickbooks).toMatchObject({ connected: false, balances: null });
    expect(s.quickbooks.note).toMatch(/press Connect/);
    expect(s.needsReview).toBe(9);          // the rest of the picture is still returned
  });

  it('reports a QuickBooks outage differently from a lapsed connection', async () => {
    const { reader } = build({ qbo: { api: vi.fn().mockRejectedValue(new Error('503')) } });
    expect((await reader.summary()).quickbooks).toMatchObject({ connected: true, balances: null, note: 'QuickBooks could not be read just now' });
  });

  it('copes with QuickBooks not being set up and with a Mac mini that never checked in', async () => {
    const { reader } = build({
      qbo: null,
      monitor: { lastRun: vi.fn().mockResolvedValue(null), getHeartbeat: vi.fn().mockResolvedValue(null) },
      batches: { latestBatchCounts: vi.fn().mockResolvedValue(null), reviewCount: vi.fn().mockResolvedValue(0), reviewCards: vi.fn() },
    });
    const s = await reader.summary();
    expect(s.quickbooks).toEqual({ connected: false, balances: null, note: 'QuickBooks is not set up' });
    expect(s.latestBatch).toBeNull();
    expect(s.lastRun).toBeNull();
    expect(s.macMini).toEqual({ lastSeenAt: null, minutesSinceCheckIn: null, state: null });
  });
});

describe('BooksReader lists', () => {
  it('caps the review queue and passes the total', async () => {
    const { reader, deps } = build();
    const out = await reader.reviewQueue(9999);
    expect(deps.batches.reviewCards).toHaveBeenCalledWith(50);
    expect(out).toEqual({ total: 9, cards: [{ id: 'r1', description: 'SHOPPERS' }] });
    await reader.reviewQueue(Number.NaN);
    expect(deps.batches.reviewCards).toHaveBeenLastCalledWith(20);
  });

  it('caps the upload list', async () => {
    const { reader, deps } = build();
    await reader.recentUploads(0);
    expect(deps.uploads.list).toHaveBeenCalledWith(1);
  });

  it('offers nothing that changes anything', () => {
    const methods = Object.getOwnPropertyNames(BooksReader.prototype).filter(m => m !== 'constructor');
    expect(methods.sort()).toEqual(['recentUploads', 'reviewQueue', 'summary']);
  });
});
