// Pure logic for the personal budget pages. No React, no fetching.
// Money is integer cents (CAD by default); negative = money out. Dates are YYYY-MM-DD.
// Bank text (payee, description) is untrusted: callers render it as text only.

export interface BudgetCategory {
  id: string;
  name: string;
  monthlyCents: number;
  rollover: boolean;
}

export type CategorySource = 'rule' | 'agent_guess' | 'you' | 'none';

export interface BudgetTxn {
  id: string;
  date: string; // YYYY-MM-DD
  payee: string;
  amountCents: number; // negative = money out
  categoryId: string | null;
  accountId: string;
  source: CategorySource;
  ruleId: string | null;
}

export type BudgetStatus = 'under' | 'near' | 'over';

export interface CategoryRowModel {
  id: string;
  name: string;
  budgetCents: number; // monthly amount plus any rollover carried in
  spentCents: number; // positive number of cents spent this month
  rolloverInCents: number;
  remainingCents: number;
  ratio: number; // spent / budget, 0 when budget is 0 and nothing spent
  status: BudgetStatus;
}

export interface NeedsYouItem {
  kind: 'uncategorised' | 'guess' | 'over_budget';
  id: string;
  label: string;
}

/** A category counts as "near" its limit from this share of the budget. */
export const NEAR_RATIO = 0.8;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  if (!isMonth(month)) throw new Error(`Invalid month: ${month}`);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const year = y + Math.floor(m / 12);
  const mon = ((m % 12) + 12) % 12;
  return `${String(year).padStart(4, '0')}-${String(mon + 1).padStart(2, '0')}`;
}

export function formatMonth(month: string, locale?: string): string {
  if (!isMonth(month)) return month;
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Format integer cents as currency. Never uses floats for the arithmetic. */
export function formatCents(cents: number, currency = 'CAD', locale?: string): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const units = Math.floor(abs / 100);
  const rem = abs % 100;
  const nf = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
  // Format whole units and cents separately from the integer to avoid float rounding surprises.
  const base = nf.format(units + rem / 100);
  return sign + base;
}

/** Parse a user-typed dollar amount ("12", "12.5", "1,200.00") to cents. Returns null when invalid. */
export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function centsToDollarInput(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function statusFor(spentCents: number, budgetCents: number): BudgetStatus {
  if (budgetCents <= 0) return spentCents > 0 ? 'over' : 'under';
  const ratio = spentCents / budgetCents;
  if (ratio > 1) return 'over';
  if (ratio >= NEAR_RATIO) return 'near';
  return 'under';
}

export const STATUS_LABEL: Record<BudgetStatus, string> = {
  under: 'Under budget',
  near: 'Near limit',
  over: 'Over budget',
};

/** Money out in a category for a month, as a positive number of cents. Refunds (money in) reduce it. */
export function spentIn(txns: BudgetTxn[], categoryId: string, month: string): number {
  let out = 0;
  for (const t of txns) {
    if (t.categoryId === categoryId && monthOf(t.date) === month) out -= t.amountCents;
  }
  return Math.max(out, 0);
}

/**
 * Rollover: unspent budget from the previous month carries into this one for categories that opt in.
 * Only one month back is counted, which keeps the first pass simple and explainable. Overspend does not carry.
 */
export function rolloverInto(cat: BudgetCategory, txns: BudgetTxn[], month: string): number {
  if (!cat.rollover) return 0;
  const prev = shiftMonth(month, -1);
  const unspent = cat.monthlyCents - spentIn(txns, cat.id, prev);
  return Math.max(unspent, 0);
}

export function buildRows(categories: BudgetCategory[], txns: BudgetTxn[], month: string): CategoryRowModel[] {
  return categories.map(cat => {
    const rolloverInCents = rolloverInto(cat, txns, month);
    const budgetCents = cat.monthlyCents + rolloverInCents;
    const spentCents = spentIn(txns, cat.id, month);
    const ratio = budgetCents > 0 ? spentCents / budgetCents : spentCents > 0 ? Infinity : 0;
    return {
      id: cat.id,
      name: cat.name,
      budgetCents,
      spentCents,
      rolloverInCents,
      remainingCents: budgetCents - spentCents,
      ratio,
      status: statusFor(spentCents, budgetCents),
    };
  });
}

export interface Totals { spentCents: number; budgetCents: number }

export function totalsOf(rows: CategoryRowModel[]): Totals {
  return rows.reduce<Totals>(
    (acc, r) => ({ spentCents: acc.spentCents + r.spentCents, budgetCents: acc.budgetCents + r.budgetCents }),
    { spentCents: 0, budgetCents: 0 },
  );
}

/** Bar fill percent, clamped for display. The real ratio stays available for text. */
export function barPercent(ratio: number): number {
  if (!Number.isFinite(ratio)) return 100;
  return Math.min(Math.max(Math.round(ratio * 100), 0), 100);
}

/** Money-out transactions in a month that have no category, plus guesses that the owner has not confirmed. */
export function needsYou(rows: CategoryRowModel[], txns: BudgetTxn[], month: string): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const inMonth = txns.filter(t => monthOf(t.date) === month);
  const uncategorised = inMonth.filter(t => t.categoryId === null);
  if (uncategorised.length > 0) {
    items.push({
      kind: 'uncategorised',
      id: 'uncategorised',
      label: `${uncategorised.length} transaction${uncategorised.length === 1 ? '' : 's'} without a category`,
    });
  }
  const guesses = inMonth.filter(t => t.source === 'agent_guess');
  if (guesses.length > 0) {
    items.push({
      kind: 'guess',
      id: 'guesses',
      label: `${guesses.length} agent guess${guesses.length === 1 ? '' : 'es'} to confirm`,
    });
  }
  for (const r of rows) {
    if (r.status === 'over') {
      items.push({ kind: 'over_budget', id: r.id, label: `${r.name} is over budget by ${formatCents(r.spentCents - r.budgetCents)}` });
    }
  }
  return items;
}

/** Summary for the morning-brief Money card (and, later, the phone app). Props in, nothing fetched. */
export interface MoneySummary {
  month: string;
  top: Array<{ id: string; name: string; spentCents: number; budgetCents: number; status: BudgetStatus }>;
  needsYouCount: number;
}

export function buildMoneySummary(categories: BudgetCategory[], txns: BudgetTxn[], month: string, topN = 3): MoneySummary {
  const rows = buildRows(categories, txns, month);
  const top = [...rows]
    .sort((a, b) => b.spentCents - a.spentCents)
    .slice(0, topN)
    .map(r => ({ id: r.id, name: r.name, spentCents: r.spentCents, budgetCents: r.budgetCents, status: r.status }));
  return { month, top, needsYouCount: needsYou(rows, txns, month).length };
}

// ---- Category validation (Budgets page) ----

export interface CategoryDraft { name: string; amount: string; rollover: boolean }

export interface DraftResult {
  ok: boolean;
  errors: { name?: string; amount?: string };
  value?: { name: string; monthlyCents: number; rollover: boolean };
}

export function validateDraft(draft: CategoryDraft, existing: BudgetCategory[], editingId: string | null): DraftResult {
  const errors: DraftResult['errors'] = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > 60) errors.name = 'Keep the name under 60 characters.';
  else if (existing.some(c => c.id !== editingId && c.name.toLowerCase() === name.toLowerCase())) {
    errors.name = 'A category with this name already exists.';
  }
  const cents = parseDollarsToCents(draft.amount);
  if (cents === null) errors.amount = 'Enter an amount like 250 or 250.00.';
  if (errors.name || errors.amount || cents === null) return { ok: false, errors };
  return { ok: true, errors, value: { name, monthlyCents: cents, rollover: draft.rollover } };
}
