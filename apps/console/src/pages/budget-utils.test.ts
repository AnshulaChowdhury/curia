import { describe, it, expect } from 'vitest';
import {
  shiftMonth, isMonth, currentMonth, formatCents, parseDollarsToCents, centsToDollarInput, barPercent, needsYouLines, validateDraft, groupAccounts,
  type AccountType, type BudgetCategory, type BudgetSummary,
} from './budget-utils.js';
import { createBudgetClient, stateForStatus } from './budget-data.js';

const CATEGORIES: BudgetCategory[] = [{ id: 'cat-groceries', name: 'Groceries', monthlyCents: 60000, rollover: false }];

describe('months', () => {
  it('shifts across year boundaries', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', -12)).toBe('2025-11');
  });
  it('reads the current month from the local date', () => {
    expect(currentMonth(new Date(2027, 0, 31, 23, 59))).toBe('2027-01');
  });
  it('validates month strings', () => {
    expect(isMonth('2026-11')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('')).toBe(false);
  });
});

describe('money', () => {
  it('formats integer cents including negatives', () => {
    expect(formatCents(12345, 'CAD', 'en-CA')).toBe('$123.45');
    expect(formatCents(-5, 'CAD', 'en-CA')).toBe('-$0.05');
  });
  it('parses typed dollars to cents without float error', () => {
    expect(parseDollarsToCents('12')).toBe(1200);
    expect(parseDollarsToCents('12.5')).toBe(1250);
    expect(parseDollarsToCents('$1,200.05')).toBe(120005);
    expect(parseDollarsToCents('0.29')).toBe(29);
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('-3')).toBeNull();
    expect(parseDollarsToCents('1.234')).toBeNull();
  });
  it('round-trips for the edit input', () => {
    expect(centsToDollarInput(25000)).toBe('250.00');
    expect(centsToDollarInput(5)).toBe('0.05');
  });
});

describe('bar', () => {
  it('clamps the bar and handles infinity', () => {
    expect(barPercent(0.5)).toBe(50);
    expect(barPercent(3)).toBe(100);
    expect(barPercent(Infinity)).toBe(100);
  });
});

const SUMMARY: BudgetSummary = {
  month: '2031-03',
  categories: [{ categoryId: 'cat-groceries', name: 'Groceries', budgetedCents: 60000, spentCents: 61000, remainingCents: -1000, state: 'over' }],
  totals: { budgetedCents: 60000, spentCents: 63000, uncategorisedSpentCents: 2000 },
  needsYou: { uncategorised: 2, guesses: 1, overBudget: 1 },
};

describe('needs you', () => {
  it('words the server counts and over-budget categories', () => {
    expect(needsYouLines(SUMMARY)).toEqual([
      '2 transactions without a category',
      '1 agent guess to confirm',
      expect.stringContaining('Groceries is over budget by'),
    ]);
    expect(needsYouLines({ ...SUMMARY, categories: [], needsYou: { uncategorised: 0, guesses: 0, overBudget: 0 } })).toEqual([]);
  });
});

describe('assets and liabilities', () => {
  const row = (id: string, type: AccountType, side: 'asset' | 'debt', balanceCents: number | null, currency = 'CAD') =>
    ({ id, source: 'manual' as const, institution: '', name: id, mask: null, type, side, currency, balanceCents, asOf: '2031-01-01T00:00:00Z' });
  it('groups one side by kind, largest first, summing only what the totals count', () => {
    const groups = groupAccounts([
      row('small', 'cash', 'asset', 10), row('car', 'vehicle', 'asset', 500), row('big', 'cash', 'asset', 90),
      row('foreign', 'cash', 'asset', 1000, 'USD'), row('card', 'credit_card', 'debt', 40),
    ], 'asset');
    expect(groups.map(g => [g.label, g.totalCents])).toEqual([['Cash', 100], ['Vehicles', 500]]);
    expect(groups[0]!.accounts.map(a => a.id)).toEqual(['foreign', 'big', 'small']);
  });
});

describe('budget client', () => {
  type Seen = { path: string; method?: string; body?: unknown };
  const fake = (seen: Seen[], reply: (path: string) => Response) => createBudgetClient(async (path, init) => {
    seen.push({ path, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(init.body as string) });
    return reply(path);
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('loads a month from the server routes', async () => {
    const seen: Seen[] = [];
    const client = fake(seen, path => json(path.includes('summary') ? SUMMARY : path.includes('transactions') ? { transactions: [] } : { categories: CATEGORIES }));
    expect(await client.loadMonth('2031-03')).toEqual({ state: 'ok', data: { categories: CATEGORIES, summary: SUMMARY, review: [] } });
    expect(seen.map(s => s.path)).toEqual([
      '/api/budget/categories',
      '/api/budget/summary?month=2031-03',
      '/api/budget/transactions?month=2031-03&needsReview=true&limit=500',
    ]);
  });
  it('creates, edits, deletes and categorises', async () => {
    const seen: Seen[] = [];
    const client = fake(seen, () => json({ ok: true }));
    await client.saveCategory({ id: null, name: 'Home', monthlyCents: 100, rollover: false });
    await client.saveCategory({ id: 'c1', name: 'Home', monthlyCents: 200, rollover: true });
    await client.deleteCategory('c1');
    await client.categorise('t1', 'c1');
    expect(seen).toEqual([
      { path: '/api/budget/categories', method: 'POST', body: { name: 'Home', monthlyCents: 100, rollover: false } },
      { path: '/api/budget/categories/c1', method: 'PATCH', body: { name: 'Home', monthlyCents: 200, rollover: true } },
      { path: '/api/budget/categories/c1', method: 'DELETE', body: undefined },
      { path: '/api/budget/transactions/t1', method: 'PATCH', body: { categoryId: 'c1' } },
    ]);
  });
  it('shows locked for 401, and the server message when a save fails', async () => {
    expect(await fake([], () => json({ error: 'no' }, 401)).loadCategories()).toEqual({ state: 'locked' });
    await expect(fake([], () => json({ error: 'A category with that name already exists' }, 409))
      .saveCategory({ id: null, name: 'Home', monthlyCents: 1, rollover: false })).rejects.toThrow('already exists');
  });
});

describe('validateDraft', () => {
  it('rejects blank, duplicate and bad amounts', () => {
    expect(validateDraft({ name: ' ', amount: '10', rollover: false }, CATEGORIES, null).errors.name).toBeTruthy();
    expect(validateDraft({ name: 'groceries', amount: '10', rollover: false }, CATEGORIES, null).errors.name).toBeTruthy();
    expect(validateDraft({ name: 'New', amount: 'x', rollover: false }, CATEGORIES, null).errors.amount).toBeTruthy();
  });
  it('allows keeping the same name while editing', () => {
    const r = validateDraft({ name: 'Groceries', amount: '650', rollover: true }, CATEGORIES, 'cat-groceries');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: 'Groceries', monthlyCents: 65000, rollover: true });
  });
});

describe('locked state', () => {
  it('treats 401 and 403 the same', () => {
    expect(stateForStatus(401)).toBe('locked');
    expect(stateForStatus(403)).toBe('locked');
    expect(stateForStatus(200)).toBe('ok');
    expect(stateForStatus(500)).toBe('error');
  });
});
