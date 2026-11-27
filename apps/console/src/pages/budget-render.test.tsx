// @vitest-environment happy-dom
// Renders the budget components directly. Covers: bank text is rendered as text, state is not colour-only.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MoneyCard } from '../components/MoneyCard.js';
import { ReviewList } from './BudgetOverviewPage.js';
import { ActionItems, SpendingPanel, StatusColumn, Tiles, CategoryBar } from './BudgetDashboard.js';
import type { DashboardData } from './budget-data.js';
import { NetWorthSummary, SideCard } from './NetWorthPage.js';

describe('MoneyCard', () => {
  const summary = {
    month: '2026-11',
    top: [{ id: 'a', name: '<img src=x onerror=alert(1)>', spentCents: 12000, budgetCents: 10000, status: 'over' as const }],
    needsYouCount: 2,
  };
  const html = renderToStaticMarkup(<MoneyCard summary={summary} />);

  it('escapes untrusted text instead of rendering it as HTML', () => {
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
  it('states the status in words and exposes the bar to assistive tech', () => {
    expect(html).toContain('Over budget');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('2 need you');
  });
});

describe('overview', () => {
  it('renders bank text as text in the review list', () => {
    const html = renderToStaticMarkup(
      <ReviewList
        txns={[{ id: 't', account: 'Card', date: '2031-03-02', payee: '<b>MARKET</b>', description: '', amountCents: -2400, categoryId: null, source: null }]}
        categories={[{ id: 'c', name: 'Groceries', monthlyCents: 100, rollover: false }]}
        busy={false}
        onCategorise={() => {}}
      />,
    );
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;MARKET');
    expect(html).toContain('Groceries');
  });
});

describe('dashboard', () => {
  const data: DashboardData = {
    categories: [], review: [], banksNeedingYou: [{ id: 'l', institution: '<i>Bank</i>', status: 'error' }],
    summary: {
      month: '2031-03',
      categories: [{ categoryId: 'a', name: '<b>Food</b>', budgetedCents: 10000, spentCents: 12000, remainingCents: -2000, state: 'over' }],
      totals: { budgetedCents: 10000, spentCents: 12000, uncategorisedSpentCents: 0 },
      needsYou: { uncategorised: 0, guesses: 0, overBudget: 1 },
    },
    netWorth: { accounts: [{ id: 'x', source: 'manual', institution: '', name: 'Cash', mask: null, type: 'cash', side: 'asset', currency: 'CAD', balanceCents: 50000, asOf: '' }], totals: { assetsCents: 50000, debtsCents: 20000, netCents: 30000, leftOut: 0 } },
    trend: {
      asOf: '2031-03-15', firstDate: '2031-01-02',
      months: [{ month: '2031-01', outCents: 100, inCents: 200 }, { month: '2031-02', outCents: 300, inCents: 100 }],
      monthToDate: { currentCents: 150, previousCents: 100 }, lastMonth: { currentCents: 300, previousCents: null }, yearToDate: { currentCents: 400, previousCents: null },
    },
  };

  it('shows net worth up front', () => {
    const html = renderToStaticMarkup(<Tiles data={data} />);
    expect(html).toContain('Net worth');
    expect(html).toContain('300.00');
  });
  it('renders names from banks and the owner as text', () => {
    const html = renderToStaticMarkup(<><ActionItems data={data} /><StatusColumn data={data} column="over" /><CategoryBar data={data} /></>);
    expect(html).not.toContain('<b>Food');
    expect(html).not.toContain('<i>Bank');
    expect(html).toContain('&lt;b&gt;Food');
  });
  it('draws the chart with a table of the same values, and a dash where there is nothing to compare', () => {
    const html = renderToStaticMarkup(<SpendingPanel data={data} />);
    expect(html).toContain('<svg');
    expect(html).toContain('Show as a table');
    expect(html).toContain('+50.0%');
    expect(html).toContain('—');
  });
});

describe('net worth', () => {
  const base = { institution: 'Invented Bank', mask: '0000', currency: 'CAD', asOf: '2031-03-02T00:00:00.000Z' };
  const data = {
    accounts: [
      { ...base, id: 'a', source: 'bank' as const, name: '<b>Chequing</b>', type: 'cash' as const, side: 'asset' as const, balanceCents: 5000 },
      { ...base, id: 'b', source: 'manual' as const, name: 'Car', type: 'vehicle' as const, side: 'asset' as const, balanceCents: 7000 },
    ],
    totals: { assetsCents: 12000, debtsCents: 0, netCents: 12000, leftOut: 1 },
  };
  it('escapes bank names and offers edits only on hand-kept entries', () => {
    const html = renderToStaticMarkup(<SideCard title="Assets" side="asset" data={data} onEdit={() => {}} onDelete={() => {}} />);
    expect(html).not.toContain('<b>');
    expect(html).toContain('aria-label="Edit Car"');
    expect(html).not.toContain('aria-label="Edit &lt;b&gt;');
  });
  it('says when accounts are left out of the totals', () => {
    expect(renderToStaticMarkup(<NetWorthSummary totals={data.totals} />)).toContain('1 account is not in these totals');
  });
});
