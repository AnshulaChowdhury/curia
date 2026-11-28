import { describe, it, expect, vi } from 'vitest';
import { NetWorthProjector, project } from '../../../src/budget/projection.js';
import { netWorth, type BudgetAccount } from '../../../src/budget/accounts-store.js';
import { BudgetReader } from '../../../src/budget/budget-reader.js';
import type { BudgetPlan } from '../../../src/budget/budget-store.js';
import type { ProposedRow } from '../../../src/budget/proposal-store.js';

const account = (side: 'asset' | 'debt', balanceCents: number | null, currency = 'CAD') => ({ side, balanceCents, currency }) as BudgetAccount;
const worth = netWorth([account('asset', 1_000_000), account('debt', 400_000), account('asset', 5, 'USD')]);
const cat = (categoryId: string, kind: 'expense' | 'income' | 'savings', amounts: Array<number | null>) =>
  ({ categoryId, name: categoryId, kind, amounts: amounts.map(cents => ({ cents, own: false })) });
const plan: BudgetPlan = { months: ['2031-04', '2031-05'], categories: [cat('pay', 'income', [500_000, 500_000]), cat('rent', 'expense', [200_000, null]), cat('save', 'savings', [100_000, 100_000])] };
const row = (over: Partial<ProposedRow>): ProposedRow => ({ action: 'update', name: 'x', kind: 'expense', categoryId: null, amounts: [], ...over });

describe('project', () => {
  it('adds income and takes expenses from today\'s net worth, month on month; savings are kept', () => {
    const p = project(worth, plan);
    expect(p.today).toEqual({ netWorthCents: 600_000, assetsCents: 1_000_000, debtsCents: 400_000 });
    expect(p.leftOut).toBe(1);
    expect(p.months.map(m => [m.incomeCents, m.expenseCents, m.changeCents, m.netWorthCents])).toEqual([
      [500_000, 200_000, 300_000, 900_000], [500_000, 0, 800_000, 1_400_000],
    ]);
  });

  it('includes waiting changes: new, changed, retyped, archived and cleared', () => {
    const p = project(worth, plan, [
      row({ action: 'create', amounts: [{ month: '2031-04', cents: 50_000, was: null }, { month: '2031-09', cents: 1, was: null }] }),
      row({ categoryId: 'rent', amounts: [{ month: '2031-04', cents: 250_000, was: 200_000 }, { month: '2031-05', cents: null, was: null }] }),
      row({ categoryId: 'save', kind: 'expense' }),
      row({ action: 'archive', categoryId: 'pay', kind: 'income' }),
    ]);
    expect(p.months.map(m => [m.incomeCents, m.expenseCents])).toEqual([[0, 400_000], [0, 100_000]]);
  });

  it('gives no net worth without a balance to start from, and marks a month with nothing budgeted', () => {
    const p = project(netWorth([account('asset', null)]), { months: ['2031-04'], categories: [cat('a', 'expense', [null])] });
    expect(p.today).toBeNull();
    expect(p.months[0]).toMatchObject({ netWorthCents: null, changeCents: 0, empty: true });
    expect(project(netWorth([]), plan).today).toBeNull();
  });
});

describe('NetWorthProjector', () => {
  const build = () => {
    const budget = { plan: vi.fn(async () => plan) };
    const projector = new NetWorthProjector(budget, { summary: async () => worth }, 'America/Toronto', () => new Date('2031-04-01T02:00:00Z'));
    return { budget, projector };
  };

  it('starts next month in the owner timezone and runs to the last month proposed', async () => {
    const { budget, projector } = build();
    await projector.forRows([row({ amounts: [{ month: '2031-03', cents: 1, was: null }, { month: '2031-08', cents: 1, was: null }] })]);
    expect(budget.plan).toHaveBeenLastCalledWith('2031-04', 5); // still March in Toronto
    await projector.forRows([]);
    expect(budget.plan).toHaveBeenLastCalledWith('2031-04', 6);
    await projector.forRows([row({ amounts: [{ month: '2040-01', cents: 1, was: null }] })]);
    expect(budget.plan).toHaveBeenLastCalledWith('2031-04', 24);
    await projector.current(99);
    expect(budget.plan).toHaveBeenLastCalledWith('2031-04', 24);
  });

  it('reaches the specialist in dollars, totals only, with its assumptions', async () => {
    const { projector } = build();
    const out = await new BudgetReader({} as never, projector).netWorth(2);
    expect(out).toMatchObject({ currency: 'CAD', today: { netWorth: 6000, assets: 10000, debts: 4000 }, accountsLeftOut: 1 });
    expect(out.months[0]).toEqual({ month: '2031-04', income: 5000, expenses: 2000, changeFromToday: 3000, netWorthAtMonthEnd: 9000 });
    expect(out.assumptions).toContain('No interest');
    expect(JSON.stringify(out)).not.toContain('institution');
  });
});
