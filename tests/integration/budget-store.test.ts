// Personal budgeting against real Postgres: the SQL behind the summary every screen reads. Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { BudgetError, BudgetStore } from '../../src/budget/budget-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const txn = (over: Record<string, unknown> = {}) =>
  ({ account: 'chequing', date: '2031-03-10', payee: 'Invented Grocer', description: 'Invented', amountCents: -2500, ...over }) as never;

describeIf('budget store', () => {
  let pool: pg.Pool;
  let store: BudgetStore;

  // The years 2029 and 2031 keep these rows apart from anything real and from the bank-sync test (2032), which runs at
  // the same time; each test starts from empty tables it owns.
  const wipe = async () => {
    await pool.query(`DELETE FROM budget_transactions WHERE (txn_date >= '2029-01-01' AND txn_date < '2030-01-01') OR (txn_date >= '2031-01-01' AND txn_date < '2032-01-01')`);
    await pool.query(`DELETE FROM budget_categories WHERE name LIKE 'T-%'`);
    await pool.query(`DELETE FROM budget_rules`);
  };
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new BudgetStore(pool);
  });
  beforeEach(wipe);
  afterAll(async () => { await wipe(); await pool.end(); });

  it('keeps names unique and archives a deleted category, returning its transactions to uncategorised', async () => {
    const food = await store.createCategory({ name: 'T-Food', monthlyCents: 10000 });
    await expect(store.createCategory({ name: 't-food' })).rejects.toMatchObject({ kind: 'conflict' });
    await store.addTransactions([txn({ categoryId: food.id, source: 'rule', ruleId: 'grocer' })]);
    await store.deleteCategory(food.id);
    const [t] = await store.listTransactions({ month: '2031-03' });
    expect(t).toMatchObject({ categoryId: null, source: null, ruleId: null });
    expect((await store.listCategories()).some(c => c.id === food.id)).toBe(false);
    await expect(store.deleteCategory(food.id)).rejects.toBeInstanceOf(BudgetError);
  });

  it('never adds the same transaction twice', async () => {
    expect(await store.addTransactions([txn(), txn()])).toEqual({ added: 1, duplicates: 1 });
    expect(await store.addTransactions([txn(), txn({ amountCents: -2600 })])).toEqual({ added: 1, duplicates: 1 });
  });

  it('summarises a month: spent against budget, income ignored, other months excluded', async () => {
    const food = await store.createCategory({ name: 'T-Food', monthlyCents: 10000 });
    const fun = await store.createCategory({ name: 'T-Fun', monthlyCents: 5000 });
    const free = await store.createCategory({ name: 'T-Free' });
    await store.addTransactions([
      txn({ categoryId: food.id, source: 'you', amountCents: -9000 }),                       // 90% of 100.00 -> near
      txn({ categoryId: food.id, source: 'you', amountCents: 400, description: 'refund' }),  // money in: not spending
      txn({ categoryId: fun.id, source: 'agent_guess', confidence: 0.7, amountCents: -6000 }), // over
      txn({ categoryId: free.id, source: 'rule', ruleId: 'r', amountCents: -100 }),
      txn({ amountCents: -300, description: 'loose' }),                                       // uncategorised
      txn({ categoryId: food.id, source: 'you', amountCents: -9999, date: '2031-04-01', description: 'next month' }),
    ]);
    const s = await store.summary('2031-03');
    const by = Object.fromEntries(s.categories.filter(c => c.name.startsWith('T-')).map(c => [c.name, c]));
    expect(by['T-Food']).toMatchObject({ budgetedCents: 10000, spentCents: 9000, remainingCents: 1000, state: 'near' });
    expect(by['T-Fun']).toMatchObject({ spentCents: 6000, remainingCents: -1000, state: 'over' });
    expect(by['T-Free']).toMatchObject({ budgetedCents: null, remainingCents: null, state: 'no_budget' });
    expect(s.totals.uncategorisedSpentCents).toBeGreaterThanOrEqual(300);
    expect(s.needsYou.guesses).toBeGreaterThanOrEqual(1);
    expect(s.needsYou.overBudget).toBeGreaterThanOrEqual(1);
  });

  it('marks an owner choice as "you" and clears it with null', async () => {
    const c = await store.createCategory({ name: 'T-Food' });
    await store.addTransactions([txn({ categoryId: c.id, source: 'agent_guess', confidence: 0.6 })]);
    const [t] = await store.listTransactions({ month: '2031-03', needsReview: true });
    expect(t).toMatchObject({ source: 'agent_guess', confidence: 0.6 });
    await store.categorise([t!.id], c.id);
    expect((await store.listTransactions({ month: '2031-03', needsReview: true }))).toHaveLength(0);
    await store.categorise([t!.id], null);
    expect((await store.listTransactions({ month: '2031-03', needsReview: true }))).toHaveLength(1);
    await expect(store.categorise([t!.id], '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('totals money out and in by month and compares only with periods the history covers', async () => {
    const row = (date: string, amountCents: number) => txn({ date, amountCents, description: `trend ${date}` });
    await store.addTransactions([
      row('2029-01-10', -1000), row('2029-02-05', -2000), row('2029-02-20', -3000), row('2029-02-28', 500),
      row('2029-03-01', -400), row('2029-03-15', -600), row('2029-03-20', -9999),
    ]);
    const t = await store.trend('2029-03-15');
    expect(t.firstDate).toBe('2029-01-10');
    expect(t.months).toEqual([
      { month: '2029-01', outCents: 1000, inCents: 0 },
      { month: '2029-02', outCents: 5000, inCents: 500 },
      { month: '2029-03', outCents: 1000, inCents: 0 },          // the 20th is after the date asked
    ]);
    expect(t.monthToDate).toEqual({ currentCents: 1000, previousCents: 2000 });   // 1-15 March against 1-15 February
    expect(t.lastMonth).toEqual({ currentCents: 5000, previousCents: null });     // history starts mid-January
    expect(t.yearToDate).toEqual({ currentCents: 7000, previousCents: null });
    expect((await store.trend('2029-03-31')).monthToDate).toEqual({ currentCents: 10999, previousCents: 5000 }); // held to 28 February
    expect((await store.trend('2028-06-01')).months).toEqual([]);
    await expect(store.trend('2029-02-30')).rejects.toBeInstanceOf(BudgetError);
    await expect(store.trend('soon')).rejects.toBeInstanceOf(BudgetError);
  });

  it('stores the rules only if they are valid YAML', async () => {
    expect(await store.getRules()).toEqual({ yaml: '', updatedAt: null });
    await store.putRules('rules:\n  - match: GROCER\n    category: Food\n');
    expect((await store.getRules()).yaml).toContain('GROCER');
    await expect(store.putRules('rules: [unclosed')).rejects.toBeInstanceOf(BudgetError);
    await expect(store.putRules('x'.repeat(70 * 1024))).rejects.toBeInstanceOf(BudgetError);
  });
});
