// @vitest-environment happy-dom
// The whole-budget grid used as a person uses it: type changes, copying an amount forward, adding months, net worth.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanGrid } from './PlanGrid.js';
import { createBudgetClient } from './budget-data.js';
import type { FullPlan } from './budget-utils.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cell = (cents: number | null) => ({ cents, own: true });
const plan: FullPlan = {
  months: ['2031-03', '2031-04', '2031-05'], truncated: false,
  categories: [
    { categoryId: 'pay', name: 'Pay', kind: 'income', amounts: [cell(500000), cell(500000), cell(500000)] },
    { categoryId: 'rent', name: 'Rent', kind: 'expense', amounts: [cell(200000), cell(null), cell(210000)] },
  ],
  projection: {
    today: { netWorthCents: 1000000, assetsCents: 1000000, debtsCents: 0 }, leftOut: 0,
    months: [{ month: '2031-04', incomeCents: 500000, expenseCents: 0, changeCents: 500000, netWorthCents: 1500000, empty: false }],
  },
};

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

function show(props: Partial<Parameters<typeof PlanGrid>[0]> = {}) {
  const onFill = vi.fn(); const onType = vi.fn(); const onAddMonths = vi.fn(); const onSet = vi.fn();
  const all = { plan, current: '2031-04', onSet, onType, onFill, onAddMonths, ...props };
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(<PlanGrid {...all} />));
  const rerender = (next: Partial<Parameters<typeof PlanGrid>[0]>) => act(() => root!.render(<PlanGrid {...all} {...next} />));
  const button = (text: string | RegExp) => [...host.querySelectorAll('button')].find(b => (typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? '')));
  const click = (text: string | RegExp) => act(() => { button(text)!.click(); });
  const select = (label: string) => act(() => { host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.focus(); });
  return { host, rerender, button, click, select, onFill, onType, onAddMonths, onSet };
}
const monthName = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1)).toLocaleDateString(undefined, { year: 'numeric', month: 'long', timeZone: 'UTC' });

describe('PlanGrid', () => {
  it('marks this month and shows net worth under the months, with a dash where none is projected', () => {
    const { host } = show();
    const current = host.querySelector('thead th[aria-current="date"]')!;
    expect(current.textContent).toBe(monthName('2031-04'));
    const worth = [...host.querySelectorAll('tfoot tr')].at(-1)!;
    expect([...worth.querySelectorAll('td')].map(td => td.textContent)).toEqual(['—', '$15,000.00', '—']);
    expect(host.textContent).toContain('If the budget holds');
  });

  it('changes a category type in place', () => {
    const { host, onType } = show();
    const box = host.querySelector<HTMLSelectElement>('select[aria-label="Type of Rent"]')!;
    act(() => { box.value = 'savings'; box.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onType).toHaveBeenCalledWith('rent', 'savings');
  });

  it('copies the selected amount to every later month, only after confirming', () => {
    const { host, click, select, button, onFill } = show();
    expect(host.textContent).toContain('select it first');
    select(`Rent, ${monthName('2031-03')}`);
    click(/^Copy Rent, \$2,000\.00, to the 2 later months$/);
    expect(onFill).not.toHaveBeenCalled();
    click('Keep');
    expect(onFill).not.toHaveBeenCalled();
    click(/^Copy Rent/);
    click('Replace');
    expect(onFill).toHaveBeenCalledWith('rent', ['2031-04', '2031-05'], 200000);
    expect(button('Replace')).toBeUndefined();
  });

  it('withdraws the question when another amount is selected, and waits for edits to be saved', () => {
    const { click, select, button, rerender, onFill } = show();
    select(`Rent, ${monthName('2031-03')}`);
    click(/^Copy Rent/);
    select(`Pay, ${monthName('2031-03')}`);
    expect(button('Replace')).toBeUndefined();
    click(/^Copy Pay/);
    rerender({ saving: true });
    expect(button('Replace')!.disabled).toBe(true);
    expect(onFill).not.toHaveBeenCalled();
  });

  it('offers no copy from an empty month or from the last one shown', () => {
    const { host, select, button } = show();
    select(`Rent, ${monthName('2031-04')}`);
    expect(host.textContent).toContain('has no amount');
    select(`Rent, ${monthName('2031-05')}`);
    expect(host.textContent).toContain('is the last month shown');
    expect(button(/^Copy/)).toBeUndefined();
  });

  it('adds later months, up to the most it can show', () => {
    const { click, button, rerender, onAddMonths } = show();
    click('Add a month');
    click('Add a year');
    expect(onAddMonths.mock.calls).toEqual([[1], [12]]);
    const long: FullPlan = { ...plan, months: Array.from({ length: 120 }, (_, i) => `${2031 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`) };
    rerender({ plan: long });
    expect(button('Add a month')!.disabled).toBe(true);
  });
});

describe('budget client, grid edits', () => {
  it('asks for later months, sets several at once and changes a type alone', async () => {
    const seen: Array<{ path: string; method: string; body?: string }> = [];
    const client = createBudgetClient(async (path, init) => {
      seen.push({ path, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return new Response(JSON.stringify({ categories: [], transactions: [] }));
    });
    await client.loadBudgets('2031-03', '2031-05', '2032-01');
    expect(seen.map(s => s.path)).toContain('/api/budget/plan?all=1&from=2031-05&through=2032-01');
    seen.length = 0;
    await client.setMonthAmounts('a', ['2031-04', '2031-05'], 900);
    await client.setKind('a', 'savings');
    expect(seen).toEqual([
      { path: '/api/budget/categories/a/months', method: 'PUT', body: '{"months":["2031-04","2031-05"],"cents":900}' },
      { path: '/api/budget/categories/a', method: 'PATCH', body: '{"kind":"savings"}' },
    ]);
  });
});
