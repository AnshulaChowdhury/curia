import { describe, it, expect } from 'vitest';
import { linesFor, loadQboLines } from '../../../src/books/qbo-lines.js';
import type { QboQueryPort } from '../../../src/books/qbo-balances.js';

const ours = new Map([['1', 'chq'], ['2', 'visa']]);

describe('linesFor', () => {
  it('signs purchases from our account, refunds as money in', () => {
    const tx = { Id: '9', TxnDate: '2026-10-01', TotalAmt: 12.34, AccountRef: { value: '2' }, EntityRef: { name: 'ACME' } };
    expect(linesFor('Purchase', tx, ours)[0]).toMatchObject({ id: 'Purchase:9', amount: '-12.34', account: 'visa', name: 'ACME' });
    expect(linesFor('Purchase', { ...tx, Credit: true }, ours)[0]?.amount).toBe('12.34');
  });

  it('turns a transfer into one line per side of ours', () => {
    const tx = { Id: '3', TxnDate: '2026-10-02', Amount: 500, FromAccountRef: { value: '1', name: 'Chequing' }, ToAccountRef: { value: '2', name: 'Visa' } };
    const lines = linesFor('Transfer', tx, ours);
    expect(lines.map(l => [l.account, l.amount])).toEqual([['chq', '-500.00'], ['visa', '500.00']]);
  });

  it('skips entries that touch none of our accounts', () => {
    expect(linesFor('Deposit', { Id: '1', TxnDate: '2026-10-01', TotalAmt: 5, DepositToAccountRef: { value: '77' } }, ours)).toEqual([]);
  });

  it('adds cents without float drift', () => {
    const lines = linesFor('JournalEntry', {
      Id: '5', TxnDate: '2026-10-03',
      Line: [{ Amount: 0.1, JournalEntryLineDetail: { AccountRef: { value: '1' }, PostingType: 'Debit' } }],
    }, ours);
    expect(lines[0]?.amount).toBe('0.10');
  });
});

describe('loadQboLines', () => {
  const accounts = [{ id: 'chq', name: 'Chequing', kind: 'bank', qbo_account: 'Chequing' }];
  const qbo = (rows: Record<string, unknown[]>): QboQueryPort => ({
    async api(_m, _p, params) {
      const q = params?.['query'] ?? '';
      const entity = /from (\w+)/.exec(q)?.[1] ?? '';
      return { QueryResponse: { [entity]: rows[entity] ?? [] } };
    },
  });

  it('reads every kind of entry in the window', async () => {
    const lines = await loadQboLines(qbo({
      Account: [{ Id: '1', Name: 'Chequing' }],
      Deposit: [{ Id: 'd', TxnDate: '2026-10-05', TotalAmt: 20, DepositToAccountRef: { value: '1' } }],
    }), accounts, { start: '2026-09-01', end: '2026-11-01' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'Deposit:d', amount: '20.00', account: 'chq' });
  });

  it('refuses when a bank account is missing from QuickBooks or the window is malformed', async () => {
    await expect(loadQboLines(qbo({ Account: [] }), accounts, { start: '2026-09-01', end: '2026-11-01' })).rejects.toThrow(/no account for: chq/);
    await expect(loadQboLines(qbo({}), accounts, { start: "x' or 1=1", end: '2026-11-01' })).rejects.toThrow(/YYYY-MM-DD/);
  });
});
