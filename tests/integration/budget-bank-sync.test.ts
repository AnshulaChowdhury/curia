// Plaid sync against real Postgres, with a fake Plaid and an in-memory vault. Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { BankSync } from '../../src/budget/bank-sync.js';
import { BudgetStore } from '../../src/budget/budget-store.js';
import { AccountStore } from '../../src/budget/accounts-store.js';
import { PlaidError, type PlaidClient, type SyncPage } from '../../src/budget/plaid-client.js';
import type { Logger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const tx = (id: string, amount: number, over: Record<string, unknown> = {}) =>
  ({ transaction_id: id, account_id: 'a1', date: '2032-03-09', amount, pending: false, name: 'INVENTED GROCER', merchant_name: null, iso_currency_code: 'CAD', ...over });
const page = (p: Partial<SyncPage>): SyncPage => ({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false, accounts: [{ account_id: 'a1', name: 'Chequing', mask: '1234' }], ...p });

describeIf('bank sync', () => {
  let pool: pg.Pool;
  const vault = new Map<string, string>();
  const secrets = { get: async (n: string) => vault.get(n) ?? null, set: async (n: string, v: string) => { vault.set(n, v); }, delete: async (n: string) => { vault.delete(n); } };
  const wipe = async () => {
    await pool.query(`DELETE FROM budget_transactions WHERE txn_date >= '2032-01-01'`);
    await pool.query(`DELETE FROM budget_bank_links WHERE institution LIKE 'T-%'`);
    vault.clear();
  };
  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await requireCuriaTestDatabase(pool); });
  beforeEach(wipe);
  afterAll(async () => { await wipe(); await pool.end(); });

  const make = (plaid: Partial<PlaidClient>) => new BankSync({ pool, plaid: { accounts: async () => [], ...plaid } as PlaidClient, secrets, budget: new BudgetStore(pool), balances: new AccountStore(pool), logger });

  it('stores the token in the vault only, imports settled rows once, and keeps two identical purchases apart', async () => {
    const sync = make({
      exchangePublicToken: async () => ({ accessToken: 'access-sandbox-xyz', itemId: 'item-t-1' }),
      sync: async () => page({ added: [tx('t1', 25), tx('t2', 25), tx('t3', 9, { pending: true })] }),
    });
    const link = await sync.connect('public-sandbox-abc', 'T-Bank');
    expect(JSON.stringify(link)).not.toContain('access-sandbox');
    expect(vault.get(`plaid_access_${link.id}`)).toBe('access-sandbox-xyz');
    expect(link.accounts).toEqual(['T-Bank Chequing ••1234']);
    const rows = await new BudgetStore(pool).listTransactions({ month: '2032-03' });
    expect(rows).toHaveLength(2);                       // the pending one is skipped; the two identical $25 purchases both land
    expect(rows.every(r => r.amountCents === -2500)).toBe(true);
    expect(await sync.syncOne(link.id)).toBe(0);         // the same page again adds nothing
  });

  it('keeps balances per bank account, tolerates a balance failure, and drops them on disconnect', async () => {
    let current = 1200.5;
    let fail = false;
    const sync = make({
      exchangePublicToken: async () => ({ accessToken: 'a', itemId: 'item-t-4' }),
      sync: async () => page({}),
      accounts: async () => {
        if (fail) throw new PlaidError('later', 'RATE_LIMIT_EXCEEDED', 429);
        return [
          { account_id: 'acc-t-chq', name: 'Chequing', mask: '1111', type: 'depository', subtype: 'checking', balances: { current, iso_currency_code: 'CAD' } },
          { account_id: 'acc-t-loc', name: 'Credit line', mask: '2222', type: 'loan', subtype: 'line of credit', balances: { current: 400, iso_currency_code: 'CAD' } },
        ];
      },
      removeItem: async () => {},
    });
    const store = new AccountStore(pool);
    const mine = async () => (await store.summary()).accounts.filter(a => a.institution === 'T-Bank4');
    const link = await sync.connect('public-sandbox-abc', 'T-Bank4');
    expect((await mine()).map(a => [a.name, a.side, a.balanceCents])).toEqual([['Chequing', 'asset', 120050], ['Credit line', 'debt', 40000]]);
    current = 900;
    await sync.syncOne(link.id);
    expect((await mine())[0]!.balanceCents).toBe(90000);                    // updated in place, not duplicated
    expect(await mine()).toHaveLength(2);
    await expect(store.deleteManual((await mine())[0]!.id)).rejects.toThrow('No such entry'); // bank rows are not hand-editable
    fail = true;
    await sync.syncOne(link.id);                                            // a failed balance call keeps the last balances
    expect((await sync.list()).find(l => l.id === link.id)!.status).toBe('active');
    expect((await mine())[0]!.balanceCents).toBe(90000);
    await sync.remove(link.id);
    expect(await mine()).toHaveLength(0);
  });

  it('adds, replaces and removes a hand-kept entry', async () => {
    const store = new AccountStore(pool);
    const made = await store.createManual({ name: 'T-Invented house', type: 'property', balanceCents: 50_000_000_00 });
    expect(made).toMatchObject({ source: 'manual', side: 'asset', balanceCents: 5_000_000_000, currency: 'CAD' });
    expect(await store.updateManual(made.id, { name: 'T-Invented house', type: 'mortgage', balanceCents: 1 })).toMatchObject({ side: 'debt', balanceCents: 1 });
    await expect(store.createManual({ name: 'x', type: 'gold', balanceCents: 1 })).rejects.toThrow('kind');
    await expect(store.createManual({ name: 'x', type: 'cash', balanceCents: -1 })).rejects.toThrow('zero or more');
    await store.deleteManual(made.id);
    expect((await store.summary()).accounts.some(a => a.id === made.id)).toBe(false);
  });

  it('marks a link needs_login when the bank asks for it, and keeps the error short', async () => {
    const sync = make({
      exchangePublicToken: async () => ({ accessToken: 'a', itemId: 'item-t-2' }),
      sync: async () => { throw new PlaidError('login again', 'ITEM_LOGIN_REQUIRED', 400); },
    });
    await expect(sync.connect('public-sandbox-abc', 'T-Bank2')).rejects.toBeInstanceOf(PlaidError);
    const [l] = (await sync.list()).filter(x => x.institution === 'T-Bank2');
    expect(l).toMatchObject({ status: 'needs_login', lastError: 'ITEM_LOGIN_REQUIRED: login again' });
  });

  it('disconnecting removes the vault token and the link even if Plaid refuses', async () => {
    const sync = make({
      exchangePublicToken: async () => ({ accessToken: 'a', itemId: 'item-t-3' }),
      sync: async () => page({}),
      removeItem: async () => { throw new PlaidError('gone', 'ITEM_NOT_FOUND', 400); },
    });
    const link = await sync.connect('public-sandbox-abc', 'T-Bank3');
    expect(await sync.remove(link.id)).toBe(true);
    expect(vault.has(`plaid_access_${link.id}`)).toBe(false);
    expect((await sync.list()).some(l => l.id === link.id)).toBe(false);
  });
});
