import { describe, it, expect } from 'vitest';
import { actionItems, axisTicks, cashCents, categorySegments, change, columnOf, inRange, shortMoney, smoothPath } from './budget-dashboard-utils.js';
import { today, type BudgetSummary, type CategorySummary, type NetWorth } from './budget-utils.js';

const category = (name: string, budgetedCents: number | null, spentCents: number, state: CategorySummary['state']): CategorySummary =>
  ({ categoryId: name, name, budgetedCents, spentCents, remainingCents: budgetedCents === null ? null : budgetedCents - spentCents, state });
const summary = (categories: CategorySummary[], uncategorised = 0, loose = 0): BudgetSummary => ({
  month: '2031-03', categories,
  totals: { budgetedCents: 0, spentCents: 0, uncategorisedSpentCents: loose },
  needsYou: { uncategorised, guesses: 0, overBudget: categories.filter(c => c.state === 'over').length },
});
const NOTHING: NetWorth = { accounts: [], totals: { assetsCents: 0, debtsCents: 0, netCents: 0, leftOut: 0 } };

describe('dashboard figures', () => {
  it('counts only counted cash accounts as cash', () => {
    const row = (type: 'cash' | 'property', balanceCents: number | null, currency = 'CAD') =>
      ({ id: 'x', source: 'manual' as const, institution: '', name: 'x', mask: null, type, side: 'asset' as const, currency, balanceCents, asOf: '' });
    expect(cashCents({ ...NOTHING, accounts: [row('cash', 100), row('cash', 50, 'USD'), row('cash', null), row('property', 900)] })).toBe(100);
  });
  it('compares spending with the earlier period, or not at all', () => {
    expect(change({ currentCents: 150, previousCents: 100 })).toEqual({ percent: 50, up: true });
    expect(change({ currentCents: 75, previousCents: 100 })).toEqual({ percent: 25, up: false });
    expect(change({ currentCents: 5, previousCents: null })).toBeNull();
    expect(change({ currentCents: 5, previousCents: 0 })).toBeNull();
  });
  it('picks the chart period', () => {
    const months = ['2030-11', '2030-12', '2031-01', '2031-02'].map(month => ({ month, outCents: 0, inCents: 0 }));
    expect(inRange(months, 'ytd', '2031-02-10').map(m => m.month)).toEqual(['2031-01', '2031-02']);
    expect(inRange(months, 'all', '2031-02-10')).toHaveLength(4);
  });
  it('reads today from the local date', () => {
    expect(today(new Date(2031, 0, 5, 23, 59))).toBe('2031-01-05');
  });
});

describe('chart geometry', () => {
  it('makes round gridlines that cover the largest amount', () => {
    const ticks = axisTicks(2_300_000);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)!).toBeGreaterThanOrEqual(2_300_000);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(axisTicks(0).at(-1)!).toBeGreaterThan(0);
    expect([shortMoney(0), shortMoney(500_000), shortMoney(150_000_000)]).toEqual(['$0', '$5K', '$1.5M']);
  });
  it('draws a curve through every point without overshooting a peak', () => {
    const d = smoothPath([[0, 100], [10, 0], [20, 100]]);
    expect(d.startsWith('M0,100')).toBe(true);
    const ys = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m => Number(m[2]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(smoothPath([])).toBe('');
    expect(smoothPath([[5, 5]])).toBe('M5,5');
  });
});

describe('category bar', () => {
  it('keeps a colour with its category, folds the ninth onward into Other, and shows what has no category', () => {
    const cats = Array.from({ length: 10 }, (_, i) => category(`c${i}`, null, i === 0 ? 0 : 100, 'no_budget'));
    const segments = categorySegments(summary(cats, 1, 40));
    expect(segments[0]).toMatchObject({ key: 'c1', slot: 2 });          // c0 spent nothing; c1 keeps the second colour
    expect(segments.find(s => s.key === 'other')).toMatchObject({ cents: 200 });
    expect(segments.at(-1)).toMatchObject({ key: 'none', cents: 40, slot: 'none' });
  });
});

describe('action items and columns', () => {
  const cats = [category('A', 100, 130, 'over'), category('B', 100, 200, 'over'), category('C', 100, 90, 'near'), category('D', 100, 99, 'near')];
  it('lists what needs the owner', () => {
    const items = actionItems({ summary: summary(cats, 2), netWorth: NOTHING, banks: [{ id: 'l', institution: 'Invented Bank', status: 'needs_login' }] });
    expect(items.map(i => i.key)).toEqual(['bank-l', 'loose', 'over', 'nobalances']);
    expect(items[1]).toMatchObject({ strong: '2 transactions', rest: 'have no category' });
  });
  it('is empty when nothing is wrong', () => {
    const fine = { ...NOTHING, accounts: [{ id: 'x', source: 'manual' as const, institution: '', name: 'x', mask: null, type: 'cash' as const, side: 'asset' as const, currency: 'CAD', balanceCents: 1, asOf: '' }] };
    expect(actionItems({ summary: summary([category('A', 100, 10, 'under')]), netWorth: fine, banks: [] })).toEqual([]);
  });
  it('puts the worst overspend and the closest to the limit first', () => {
    expect(columnOf(summary(cats), 'over').categories.map(c => c.name)).toEqual(['B', 'A']);
    expect(columnOf(summary(cats), 'near').categories.map(c => c.name)).toEqual(['D', 'C']);
    expect(columnOf(summary(cats), 'over')).toMatchObject({ spentCents: 330, budgetedCents: 200 });
  });
});
