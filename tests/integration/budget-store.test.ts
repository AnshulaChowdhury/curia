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
    await pool.query(`DELETE FROM budget_categories WHERE name LIKE 'T-%'`);   // after their transactions: the key restricts
    await pool.query(`DELETE FROM budget_rules`);
  };
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new BudgetStore(pool);
  });
  beforeEach(wipe);
  afterAll(async () => { await wipe(); await pool.end(); });

  it('budgets by month, falling back to the usual amount, and counts only spending in the summary', async () => {
    const food = await store.createCategory({ name: 'T-Food', monthlyCents: 10000 });
    const pay = await store.createCategory({ name: 'T-Pay', kind: 'income' });
    await expect(store.createCategory({ name: 'T-Bad', kind: 'other' })).rejects.toMatchObject({ kind: 'invalid' });
    await store.setMonthAmount(food.id, '2031-04', 25000);
    await store.setMonthAmount(food.id, '2031-04', 20000);
    await store.setMonthAmount(pay.id, '2031-03', 500000);
    await expect(store.setMonthAmount(pay.id, '2031-13', 1)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(store.setMonthAmount(pay.id, '2031-03', -1)).rejects.toMatchObject({ kind: 'invalid' });

    const plan = await store.plan('2031-03', 2);
    expect(plan.months).toEqual(['2031-03', '2031-04']);
    const row = (id: string) => plan.categories.find(c => c.categoryId === id)!;
    expect(row(food.id).amounts).toEqual([{ cents: 10000, own: false }, { cents: 20000, own: true }]);
    expect(row(pay.id)).toMatchObject({ kind: 'income', amounts: [{ cents: 500000, own: true }, { cents: null, own: false }] });

    const april = await store.summary('2031-04');
    expect(april.categories.find(c => c.categoryId === food.id)).toMatchObject({ budgetedCents: 20000 });
    expect(april.categories.some(c => c.categoryId === pay.id)).toBe(false);

    await store.setMonthAmount(food.id, '2031-04', null);
    expect((await store.summary('2031-04')).categories.find(c => c.categoryId === food.id)).toMatchObject({ budgetedCents: 10000 });
    await store.setMonthAmount(food.id, '2031-04', 1);
    await store.deleteCategory(food.id); // its month amounts go with it
    await store.archiveCategory(pay.id);
    await expect(store.setMonthAmount(pay.id, '2031-03', 1)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps open names unique, deletes only an empty category, and frees an archived name', async () => {
    const food = await store.createCategory({ name: 'T-Food', monthlyCents: 10000 });
    await expect(store.createCategory({ name: 't-food' })).rejects.toMatchObject({ kind: 'conflict' });
    const spare = await store.createCategory({ name: 'T-Spare' });
    await store.deleteCategory(spare.id);
    expect((await store.listCategories({ includeArchived: true })).some(c => c.id === spare.id)).toBe(false);
    await expect(store.deleteCategory(spare.id)).rejects.toMatchObject({ kind: 'not_found' });

    await store.addTransactions([txn({ categoryId: food.id, source: 'rule', ruleId: 'grocer' })]);
    await expect(store.deleteCategory(food.id)).rejects.toMatchObject({ kind: 'conflict', message: expect.stringContaining('Archive') });
    expect(await store.archiveCategory(food.id)).toMatchObject({ archived: true, transactionCount: 1 });
    await expect(store.archiveCategory(food.id)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(store.deleteCategory(food.id)).rejects.toMatchObject({ kind: 'conflict' });
    expect((await store.listCategories()).some(c => c.id === food.id)).toBe(false);
    const again = await store.createCategory({ name: 'T-Food' });          // the name is free again
    expect(again.sortOrder).toBeGreaterThan(food.sortOrder);
  });

  it('leaves an archived category its transactions and lets nothing new into it, whoever writes', async () => {
    const old = await store.createCategory({ name: 'T-Old' });
    const open = await store.createCategory({ name: 'T-Open' });
    await store.addTransactions([txn({ categoryId: old.id, source: 'agent_guess', confidence: 0.5 }), txn({ description: 'loose' })]);
    await store.archiveCategory(old.id);
    const [kept, loose] = await Promise.all([
      store.listTransactions({ month: '2031-03', categoryId: old.id }),
      store.listTransactions({ month: '2031-03' }).then(rows => rows.filter(r => r.categoryId === null)),
    ]);
    expect(kept).toHaveLength(1);
    await expect(store.categorise([loose[0]!.id], old.id)).rejects.toBeInstanceOf(BudgetError);
    await expect(store.addTransactions([txn({ description: 'new', categoryId: old.id, source: 'rule' })])).rejects.toMatchObject({ kind: 'conflict' });
    // Straight to the database, as a writer that skips the store's own check would.
    await expect(pool.query(`UPDATE budget_transactions SET category_id = $2, source = 'rule' WHERE id = $1`, [loose[0]!.id, old.id]))
      .rejects.toMatchObject({ constraint: 'budget_category_archived' });
    await store.categorise([kept[0]!.id], open.id);                        // moving one out is fine
    expect(await store.listTransactions({ month: '2031-03', categoryId: old.id })).toHaveLength(0);
  });

  it('shows an archived category only in months it has transactions, with its budget only for months already over', async () => {
    const c = await store.createCategory({ name: 'T-Gone', monthlyCents: 5000 });
    await store.addTransactions([
      txn({ categoryId: c.id, source: 'you', date: '2031-03-10', amountCents: -6000 }),
      txn({ categoryId: c.id, source: 'you', date: '2031-05-10', amountCents: -100, description: 'later' }),
    ]);
    await store.archiveCategory(c.id);
    await pool.query(`UPDATE budget_categories SET archived_at = '2031-05-15' WHERE id = $1`, [c.id]);
    const find = async (month: string) => (await store.summary(month)).categories.find(x => x.categoryId === c.id);
    expect(await find('2031-03')).toMatchObject({ archived: true, budgetedCents: 5000, spentCents: 6000, state: 'over' });
    expect(await find('2031-05')).toMatchObject({ archived: true, budgetedCents: null, spentCents: 100, state: 'no_budget' });
    expect(await find('2031-04')).toBeUndefined();
    expect((await store.summary('2031-03')).totals.spentCents).toBe(6000);
    expect((await store.summary('2031-03')).needsYou.overBudget).toBe(0);    // nothing the owner can act on
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

  it('returns the whole budget: the first budgeted month through the last, the current month and any asked for', async () => {
    const rent = await store.createCategory({ name: 'T-Rent' });
    const gone = await store.createCategory({ name: 'T-Gone' });
    await store.setMonthAmount(rent.id, '2031-02', 100);
    await store.setMonthAmount(rent.id, '2033-05', 200);            // 28 months: past what a plain plan allows
    await store.setMonthAmount(gone.id, '2029-01', 1);
    await store.archiveCategory(gone.id);                           // a closed category does not stretch the span

    const all = await store.planAll('2031-04');
    expect([all.months[0], all.months.at(-1), all.months.length, all.truncated]).toEqual(['2031-02', '2033-05', 28, false]);
    const row = all.categories.find(c => c.categoryId === rent.id)!;
    expect([row.amounts[0]!.cents, row.amounts.at(-1)!.cents, row.amounts[1]!.cents]).toEqual([100, 200, null]);

    expect((await store.planAll('2031-04', '2033-08')).months.at(-1)).toBe('2033-08');
    expect((await store.planAll('2030-11')).months[0]).toBe('2030-11');
    expect((await store.planAll('2034-01')).months.at(-1)).toBe('2034-01');
    await expect(store.planAll('2031-13')).rejects.toMatchObject({ kind: 'invalid' });
    await expect(store.planAll('2031-04', 'soon')).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('keeps the current month in sight when the budget is longer than ten years', async () => {
    const rent = await store.createCategory({ name: 'T-Rent' });
    await store.setMonthAmount(rent.id, '2001-01', 1);
    await store.setMonthAmount(rent.id, '2099-12', 2);
    const all = await store.planAll('2031-04');
    expect([all.months[0], all.months.at(-1), all.months.length, all.truncated]).toEqual(['2029-04', '2039-03', 120, true]);
  });

  it('sets one amount on several months at once, all or none', async () => {
    const rent = await store.createCategory({ name: 'T-Rent' });
    await store.setMonthAmount(rent.id, '2031-04', 1);
    await store.setMonthAmounts(rent.id, ['2031-04', '2031-05', '2031-06', '2031-06'], 90000);
    const cents = async () => (await store.plan('2031-03', 4)).categories.find(c => c.categoryId === rent.id)!.amounts.map(a => a.cents);
    expect(await cents()).toEqual([null, 90000, 90000, 90000]);

    await expect(store.setMonthAmounts(rent.id, ['2031-03', '2031-13'], 5)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(store.setMonthAmounts(rent.id, [], 5)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(store.setMonthAmounts(rent.id, ['2031-03'], -1)).rejects.toMatchObject({ kind: 'invalid' });
    expect(await cents()).toEqual([null, 90000, 90000, 90000]);

    await store.setMonthAmounts(rent.id, ['2031-04', '2031-05'], null);
    expect(await cents()).toEqual([null, null, null, 90000]);
    await store.archiveCategory(rent.id);
    await expect(store.setMonthAmounts(rent.id, ['2031-03'], 5)).rejects.toMatchObject({ kind: 'not_found' });
  });
});

