// Plaid sync against real Postgres, with a fake Plaid and an in-memory vault. Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { BankSync } from '../../src/budget/bank-sync.js';
import { BudgetStore } from '../../src/budget/budget-store.js';
import { AccountStore } from '../../src/budget/accounts-store.js';
import { PlaidError, type PlaidAccount, type PlaidClient, type SyncPage } from '../../src/budget/plaid-client.js';
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
    await pool.query(`DELETE FROM budget_bank_account_history WHERE institution LIKE 'T-%'`);
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
    const { link } = await sync.connect('public-sandbox-abc', 'T-Bank');
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
    const { link } = await sync.connect('public-sandbox-abc', 'T-Bank4');
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
    const { link } = await sync.connect('public-sandbox-abc', 'T-Bank3');
    expect(await sync.remove(link.id)).toBe(true);
    expect(vault.has(`plaid_access_${link.id}`)).toBe(false);
    expect((await sync.list()).some(l => l.id === link.id)).toBe(false);
  });

  // -- the same account twice, and logging in again -------------------------------------------------------------

  /** One login at a bank. Plaid issues its own account ids on every connection, so `ids` differ between logins. */
  interface Login { item: string; accounts: PlaidAccount[]; added: SyncPage['added'] }
  const acct = (id: string, name: string, mask: string): PlaidAccount =>
    ({ account_id: id, name, mask, type: 'depository', subtype: 'checking', balances: { current: 10, iso_currency_code: 'CAD' } });
  const banks = (logins: Record<string, Login>) => {
    const removed: string[] = [];
    const of = (token: string) => logins[token]!;
    const sync = make({
      exchangePublicToken: async (pub: string) => ({ accessToken: pub, itemId: of(pub).item }),
      accounts: async (token: string) => of(token).accounts,
      sync: async (token: string) => page({ added: of(token).added, accounts: of(token).accounts }),
      removeItem: async (token: string) => { removed.push(token); },
    });
    return { sync, removed };
  };
  const stored = async () => (await new BudgetStore(pool).listTransactions({ month: '2032-03' }))
    .map(r => `${r.date} ${r.account} ${r.amountCents}`).sort();

  const first: Login = { item: 'item-t-first', accounts: [acct('first-joint', 'Joint', '1111')], added: [tx('f1', 25, { account_id: 'first-joint' })] };
  const second: Login = {
    item: 'item-t-second',
    // The second holder's bank names the shared account differently; the last digits are the same.
    accounts: [acct('second-joint', 'Shared', '1111'), acct('second-own', 'Own', '2222')],
    added: [tx('s1', 25, { account_id: 'second-joint' }), tx('s2', 7, { account_id: 'second-own' })],
  };

  it('leaves out an account already connected through another login, and says so', async () => {
    const { sync, removed } = banks({ first, second });
    await sync.connect('first', 'T-Joint');
    const result = await sync.connect('second', 'T-Joint');

    expect(result.notice).toBe('T-Joint Shared ••1111 is already connected, so it was not added again. ' +
      'Adding it twice would double-count transactions and balances. The other account was added.');
    expect(result.link.accounts).toEqual(['T-Joint Own ••2222']);
    expect(await stored()).toEqual(['2032-03-09 T-Joint Joint ••1111 -2500', '2032-03-09 T-Joint Own ••2222 -700']);
    const balances = (await new AccountStore(pool).summary()).accounts.filter(a => a.institution === 'T-Joint');
    expect(balances.map(a => a.mask).sort()).toEqual(['1111', '2222']);
    expect(removed).toEqual([]);

    await sync.syncOne(result.link.id);                       // still left out on the next sync
    expect(await stored()).toHaveLength(2);
  });

  it('adds nothing, and removes the connection at Plaid, when every account is already connected', async () => {
    const again: Login = { item: 'item-t-again', accounts: [acct('again-joint', 'Joint', '1111')], added: [tx('a1x', 25, { account_id: 'again-joint' })] };
    const { sync, removed } = banks({ first, again });
    await sync.connect('first', 'T-Joint');

    await expect(sync.connect('again', 'T-Joint')).rejects.toThrow(/^Nothing was added\. T-Joint Joint ••1111 is already connected/);
    expect(removed).toEqual(['again']);
    expect((await sync.list()).filter(l => l.institution === 'T-Joint')).toHaveLength(1);
    expect([...vault.values()]).toEqual(['first']);
    expect(await stored()).toHaveLength(1);
  });

  it('treats the same digits at another bank, or on another kind of account, as a different account', async () => {
    const elsewhere: Login = { item: 'item-t-else', accounts: [acct('else-1', 'Joint', '1111')], added: [] };
    const card: Login = { item: 'item-t-card', accounts: [{ ...acct('card-1', 'Card', '1111'), type: 'credit', subtype: 'credit card' }], added: [] };
    const { sync } = banks({ first, elsewhere, card });
    await sync.connect('first', 'T-Joint');
    expect((await sync.connect('elsewhere', 'T-Other')).notice).toBeNull();
    expect((await sync.connect('card', 'T-Joint')).notice).toBeNull();
  });

  it('adds nothing when the accounts cannot be checked', async () => {
    const removeItem = vi.fn(async () => {});
    const sync = make({
      exchangePublicToken: async () => ({ accessToken: 'unchecked', itemId: 'item-t-unchecked' }),
      accounts: async () => { throw new PlaidError('later', 'RATE_LIMIT_EXCEEDED', 429); },
      removeItem,
    });
    await expect(sync.connect('public-sandbox-abc', 'T-Unchecked')).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(removeItem).toHaveBeenCalledWith('unchecked');
    expect((await sync.list()).some(l => l.institution === 'T-Unchecked')).toBe(false);
    expect(vault.size).toBe(0);
  });

  it('imports only what is new when a disconnected account is added again', async () => {
    const before: Login = {
      item: 'item-t-before', accounts: [acct('before-1', 'Chequing', '3333')],
      added: [tx('b1', 5, { account_id: 'before-1', date: '2032-03-01' }), tx('b2', 25, { account_id: 'before-1', date: '2032-03-09' })],
    };
    const t = (id: string, amount: number, date: string) => tx(id, amount, { account_id: 'after-1', date });
    const after: Login = {
      item: 'item-t-after', accounts: [acct('after-1', 'Everyday', '3333')],
      // History again under new ids, a second $25 and a $4 on the last day stored, and a later purchase.
      added: [t('n1', 5, '2032-03-01'), t('n2', 25, '2032-03-09'), t('n3', 25, '2032-03-09'), t('n4', 4, '2032-03-09'), t('n5', 8, '2032-03-12')],
    };
    const { sync } = banks({ before, after });
    const { link } = await sync.connect('before', 'T-Again');
    await sync.remove(link.id);
    const result = await sync.connect('after', 'T-Again');

    expect(result.notice).toBeNull();
    // The account keeps the name its transactions already have.
    expect(result.link.accounts).toEqual(['T-Again Chequing ••3333']);
    expect(await stored()).toEqual([
      '2032-03-01 T-Again Chequing ••3333 -500',
      '2032-03-09 T-Again Chequing ••3333 -2500', '2032-03-09 T-Again Chequing ••3333 -2500', '2032-03-09 T-Again Chequing ••3333 -400',
      '2032-03-12 T-Again Chequing ••3333 -800',
    ]);
  });

  it('forgets an account it never imported when that connection is removed', async () => {
    const { sync } = banks({ first, second });
    await sync.connect('first', 'T-Joint');
    const { link } = await sync.connect('second', 'T-Joint');
    await sync.remove(link.id);
    const { rows } = await pool.query(`SELECT external_id, link_id FROM budget_bank_account_history WHERE institution = 'T-Joint' ORDER BY external_id`);
    expect(rows.map(r => [r.external_id, r.link_id !== null])).toEqual([['first-joint', true], ['second-own', false]]);
  });

  it('never leaves out an account that a connection was importing before history was kept', async () => {
    const { sync } = banks({ first, second });
    await sync.connect('first', 'T-Joint');
    const { link } = await sync.connect('second', 'T-Joint');
    // As an older install could be: two connections already importing the same account, and no history for one.
    await pool.query('DELETE FROM budget_bank_account_history WHERE link_id = $1', [link.id]);
    await pool.query(`UPDATE budget_bank_links SET accounts = accounts || '{"second-joint":"T-Joint Shared ••1111"}'::jsonb WHERE id = $1`, [link.id]);
    await sync.syncOne(link.id);
    expect((await sync.list()).find(l => l.id === link.id)!.accounts.sort()).toEqual(['T-Joint Own ••2222', 'T-Joint Shared ••1111']);
  });

  it('logs in again on the same connection, without making a second one', async () => {
    let loginNeeded = false;
    const createLinkToken = vi.fn(async () => 'link-sandbox-update');
    const sync = make({
      createLinkToken,
      exchangePublicToken: async () => ({ accessToken: 'kept-token', itemId: 'item-t-relogin' }),
      accounts: async () => [acct('re-1', 'Chequing', '4444')],
      sync: async () => {
        if (loginNeeded) throw new PlaidError('login again', 'ITEM_LOGIN_REQUIRED', 400);
        return page({ added: [tx('r1', 3, { account_id: 're-1' })], accounts: [acct('re-1', 'Chequing', '4444')] });
      },
    });
    const { link } = await sync.connect('public-sandbox-abc', 'T-Relogin');
    loginNeeded = true;
    await expect(sync.syncOne(link.id)).rejects.toBeInstanceOf(PlaidError);

    expect(await sync.reconnectToken(link.id)).toBe('link-sandbox-update');
    expect(createLinkToken).toHaveBeenCalledWith('owner', 'kept-token');

    loginNeeded = false;
    await sync.syncOne(link.id);
    const mine = (await sync.list()).filter(l => l.institution === 'T-Relogin');
    expect(mine.map(l => [l.id, l.status])).toEqual([[link.id, 'active']]);
    expect(await stored()).toHaveLength(1);
    await expect(sync.reconnectToken('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'NO_TOKEN' });
  });
});
