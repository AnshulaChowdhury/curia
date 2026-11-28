// @vitest-environment happy-dom
// Renders the budget components directly. Covers: bank text is rendered as text, state is not colour-only.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MoneyCard } from '../components/MoneyCard.js';
import { OverviewView } from './BudgetOverviewPage.js';
import { ReconcileSection, ReviewList } from './ReconcilePanel.js';
import { monthFromSearch, RetireActions } from './BudgetsPage.js';
import { ActionItems, SpendingPanel, StatusColumn, Tiles, CategoryBar } from './BudgetDashboard.js';
import type { DashboardData } from './budget-data.js';
import { NetWorthSummary, SideCard } from './NetWorthPanel.js';
import { PlanGrid } from './PlanGrid.js';

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
        categories={[{ id: 'c', name: 'Groceries', kind: 'expense', monthlyCents: 100, rollover: false, archived: false, transactionCount: 0 }]}
        busy={false}
        onCategorise={() => {}}
      />,
    );
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;MARKET');
    expect(html).toContain('Groceries');
  });
});

describe('archived categories', () => {
  const category = (over: Partial<{ archived: boolean; transactionCount: number }>) =>
    ({ id: 'c', name: 'Old', kind: 'expense' as const, monthlyCents: 100, rollover: false, archived: false, transactionCount: 0, ...over });
  const actions = (transactionCount: number, confirming = false) => renderToStaticMarkup(
    <RetireActions c={category({ transactionCount })} confirming={confirming} onAsk={() => {}} onKeep={() => {}} onConfirm={() => {}} />);

  it('offers delete for an empty category and archive for a used one, saying what happens', () => {
    expect(actions(0)).toContain('aria-label="Delete Old"');
    expect(actions(2)).toContain('aria-label="Archive Old"');
    expect(actions(2, true)).toContain('Its 2 transactions keep it');
  });
  it('shows an archived guess without letting it be confirmed or chosen again', () => {
    const html = renderToStaticMarkup(
      <ReviewList
        txns={[{ id: 't', account: 'Card', date: '2031-03-02', payee: 'Shop', description: '', amountCents: -100, categoryId: 'c', source: 'agent_guess' }]}
        categories={[category({ archived: true })]} busy={false} onCategorise={() => {}}
      />,
    );
    expect(html).toContain('Old (archived)');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Confirm guess');
  });
});

describe('dashboard', () => {
  const data: DashboardData = {
    banksNeedingYou: [{ id: 'l', institution: '<i>Bank</i>', status: 'error' }],
    summary: {
      month: '2031-03',
      categories: [{ categoryId: 'a', name: '<b>Food</b>', archived: false, budgetedCents: 10000, spentCents: 12000, remainingCents: -2000, state: 'over' }],
      totals: { budgetedCents: 10000, spentCents: 12000, uncategorisedSpentCents: 0 },
      needsYou: { uncategorised: 0, guesses: 0, overBudget: 1 },
    },
    netWorth: { accounts: [{ id: 'x', source: 'manual', institution: '', name: 'Cash', mask: null, type: 'cash', side: 'asset', currency: 'CAD', balanceCents: 50000, asOf: '' }], totals: { assetsCents: 50000, debtsCents: 20000, netCents: 30000, savingsCents: 50000, leftOut: 0 } },
    trend: {
      asOf: '2031-03-15', firstDate: '2031-01-02',
      months: [{ month: '2031-01', outCents: 100, inCents: 200 }, { month: '2031-02', outCents: 300, inCents: 100 }],
      monthToDate: { currentCents: 150, previousCents: 100 }, lastMonth: { currentCents: 300, previousCents: null }, yearToDate: { currentCents: 400, previousCents: null },
    },
  };

  it('holds the whole picture on one page: tiles, then assets and liabilities, with no review list', () => {
    const html = renderToStaticMarkup(<OverviewView load={{ state: 'ok', data }} month="2031-03" onMonth={() => {}} onChanged={async () => {}} accounts={null} />);
    expect(html).toContain('id="bud-networth"');
    expect(html).toContain('aria-label="Assets"');
    expect(html).toContain('aria-label="Liabilities"');
    expect(html).toContain('href="#bud-networth"');
    expect(html).toContain('Add an asset or liability');
    expect(html).not.toContain('Needs a category');
  });
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

describe('reconciliation', () => {
  const section = (data: Parameters<typeof ReconcileSection>[0]['data']) => renderToStaticMarkup(
    <ReconcileSection month="2031-03" data={data} busy={false} error={null} onMonth={() => {}} onCategorise={() => {}} />);
  const txn = { id: 't', account: 'Card', date: '2031-03-02', payee: 'Shop', description: '', amountCents: -100, categoryId: null, source: null };

  it('says when there is nothing left, and keeps the month picker', () => {
    const html = section({ categories: [], review: [] });
    expect(html).toContain('Nothing to categorise in');
    expect(html).toContain('aria-label="Previous month"');
  });
  it('asks for a budget first when there is no category to choose', () => {
    expect(section({ categories: [], review: [txn] })).toContain('Add a budget below');
  });
  it('shows no rows while the chosen month loads', () => {
    expect(section(null)).toContain('Loading');
  });
  it('opens on the month it was linked with', () => {
    expect(monthFromSearch('?month=2031-03')).toBe('2031-03');
    expect(monthFromSearch('?month=<x>')).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('net worth', () => {
  const base = { institution: 'Invented Bank', mask: '0000', currency: 'CAD', asOf: '2031-03-02T00:00:00.000Z' };
  const data = {
    accounts: [
      { ...base, id: 'a', source: 'bank' as const, name: '<b>Chequing</b>', type: 'cash' as const, side: 'asset' as const, balanceCents: 5000 },
      { ...base, id: 'b', source: 'manual' as const, name: 'Car', type: 'vehicle' as const, side: 'asset' as const, balanceCents: 7000 },
    ],
    totals: { assetsCents: 12000, debtsCents: 0, netCents: 12000, savingsCents: 7700, leftOut: 1 },
  };
  it('escapes bank names and offers edits only on hand-kept entries', () => {
    const html = renderToStaticMarkup(<SideCard title="Assets" side="asset" data={data} onEdit={() => {}} onDelete={() => {}} />);
    expect(html).not.toContain('<b>');
    expect(html).toContain('aria-label="Edit Car"');
    expect(html).not.toContain('aria-label="Edit &lt;b&gt;');
  });
  it('shows total savings beside what is owned and owed', () => {
    const html = renderToStaticMarkup(<NetWorthSummary totals={{ ...data.totals, savingsCents: 7700 }} />);
    expect(html).toContain('<dt>Total savings</dt><dd>$77.00</dd>');
    expect(html).toContain('chequing included');
  });
  it('says when accounts are left out of the totals', () => {
    expect(renderToStaticMarkup(<NetWorthSummary totals={data.totals} />)).toContain('1 account is not in these totals');
  });
});

describe('budget by month', () => {
  const cell = (cents: number | null) => ({ cents, own: true });
  it('shows income, expenses and savings by month with totals and what is left over', () => {
    const html = renderToStaticMarkup(<PlanGrid onSet={() => {}} plan={{ months: ['2031-03', '2031-04'], categories: [
      { categoryId: 'a', name: '<i>Pay</i>', kind: 'income', amounts: [cell(500000), cell(600000)] },
      { categoryId: 'b', name: 'Rent', kind: 'expense', amounts: [cell(200000), cell(null)] },
      { categoryId: 'c', name: 'Nest egg', kind: 'savings', amounts: [cell(100000), cell(100000)] },
    ] }} />);
    expect(html).not.toContain('<i>');
    for (const text of ['Income', 'Expenses', 'Savings', 'Total income', 'Left over', '$2,000.00', '$5,000.00', 'value="2000.00"']) expect(html).toContain(text);
    expect(html.indexOf('Total income')).toBeLessThan(html.indexOf('Rent'));
  });
  it('says how to begin when there are no categories', () => {
    expect(renderToStaticMarkup(<PlanGrid onSet={() => {}} plan={{ months: ['2031-03'], categories: [] }} />)).toContain('No categories yet');
  });
});
