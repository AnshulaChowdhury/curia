import { describe, it, expect } from 'vitest';
import { netWorth, typeForPlaid, type BudgetAccount } from '../../../src/budget/accounts-store.js';

const account = (over: Partial<BudgetAccount>): BudgetAccount => ({
  id: 'x', source: 'manual', institution: '', name: 'Invented', mask: null, type: 'cash', side: 'asset',
  currency: 'CAD', balanceCents: 0, asOf: '2031-01-01T00:00:00.000Z', ...over,
});

describe('typeForPlaid', () => {
  it.each([
    ['depository', 'savings', 'cash'],
    ['credit', 'credit card', 'credit_card'],
    ['credit', 'line of credit', 'line_of_credit'],
    ['loan', 'line of credit', 'line_of_credit'],
    ['loan', 'mortgage', 'mortgage'],
    ['loan', 'auto', 'loan'],
    ['investment', 'rrsp', 'investment'],
    ['other', null, 'other_asset'],
  ])('%s / %s is %s', (type, subtype, expected) => {
    expect(typeForPlaid(type, subtype)).toBe(expected);
  });

  it('counts cash and investments as savings, not property or vehicles', () => {
    const { totals } = netWorth([
      account({ balanceCents: 100 }), account({ type: 'investment', balanceCents: 2_000 }),
      account({ type: 'property', balanceCents: 900_000 }), account({ type: 'vehicle', balanceCents: 30_000 }),
      account({ type: 'investment', currency: 'USD', balanceCents: 5 }),
    ]);
    expect(totals.savingsCents).toBe(2_100);
  });
});

describe('netWorth', () => {
  it('adds assets, subtracts debts, and counts what it leaves out', () => {
    const { totals } = netWorth([
      account({ balanceCents: 100_000 }),
      account({ balanceCents: -500 }),                                  // an overdrawn account lowers assets
      account({ type: 'credit_card', side: 'debt', balanceCents: 30_000 }),
      account({ currency: 'USD', balanceCents: 999_999 }),
      account({ balanceCents: null }),
    ]);
    expect(totals).toEqual({ assetsCents: 99_500, debtsCents: 30_000, netCents: 69_500, savingsCents: 99_500, leftOut: 2 });
  });
  it('is zero with nothing', () => {
    expect(netWorth([]).totals).toEqual({ assetsCents: 0, debtsCents: 0, netCents: 0, savingsCents: 0, leftOut: 0 });
  });
});
