import { describe, it, expect } from 'vitest';
import { quickbooksBalances } from '../../../src/books/qbo-balances.js';

const acct = (AccountType: string, CurrentBalance: number) => ({ AccountType, CurrentBalance });

describe('quickbooksBalances', () => {
  it('sums bank accounts, the four liability types and receivables, and ignores everything else', async () => {
    const api = async () => ({
      QueryResponse: {
        Account: [
          acct('Bank', 1000.10), acct('Bank', 250.20),
          acct('Credit Card', 400), acct('Accounts Payable', 100.05), acct('Other Current Liability', 50), acct('Long Term Liability', 20),
          acct('Accounts Receivable', 75.5),
          acct('Other Current Asset', 9999), acct('Income', 8888), acct('Expense', 7777), acct('Equity', 6666),
        ],
      },
    });
    expect(await quickbooksBalances({ api })).toEqual({ cash: 1250.3, liabilities: 570.05, receivable: 75.5 });
  });

  it('avoids floating-point drift by adding cents', async () => {
    const api = async () => ({ QueryResponse: { Account: [acct('Bank', 0.1), acct('Bank', 0.2)] } });
    expect((await quickbooksBalances({ api })).cash).toBe(0.3);
  });

  it('pages through more than a thousand accounts and copes with no accounts', async () => {
    const calls: string[] = [];
    const api = async (_m: string, _p: string, params?: Record<string, string>) => {
      calls.push(params!['query']!);
      return { QueryResponse: { Account: calls.length === 1 ? Array.from({ length: 1000 }, () => acct('Bank', 1)) : [acct('Bank', 5)] } };
    };
    expect((await quickbooksBalances({ api })).cash).toBe(1005);
    expect(calls[0]).toContain('STARTPOSITION 1 ');
    expect(calls[1]).toContain('STARTPOSITION 1001 ');
    expect(await quickbooksBalances({ api: async () => ({}) })).toEqual({ cash: 0, liabilities: 0, receivable: 0 });
  });

  it('treats a missing balance as zero', async () => {
    expect((await quickbooksBalances({ api: async () => ({ QueryResponse: { Account: [{ AccountType: 'Bank' }] } }) })).cash).toBe(0);
  });
});
