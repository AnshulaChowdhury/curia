// Pure logic for the personal budget pages. No React, no fetching.
// Money is integer cents (CAD by default); negative = money out. Dates are YYYY-MM-DD.
// Bank text (payee, description) is untrusted: callers render it as text only.

// The shapes below mirror what the server returns (src/budget/budget-store.ts).
export interface BudgetCategory {
  id: string;
  name: string;
  monthlyCents: number | null; // null = no budget set
  rollover: boolean;
  /** Archived: keeps its transactions, takes no new ones. */
  archived: boolean;
  transactionCount: number;
}

export interface BudgetTxn {
  id: string;
  account: string;
  date: string; // YYYY-MM-DD
  payee: string;
  description: string;
  amountCents: number; // negative = money out
  categoryId: string | null;
  source: 'rule' | 'agent_guess' | 'you' | null; // null = not categorised yet
}

export type BudgetStatus = 'under' | 'near' | 'over';

export interface CategorySummary {
  categoryId: string;
  name: string;
  archived: boolean;
  budgetedCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  state: 'no_budget' | BudgetStatus;
}

export interface BudgetSummary {
  month: string;
  categories: CategorySummary[];
  totals: { budgetedCents: number; spentCents: number; uncategorisedSpentCents: number };
  needsYou: { uncategorised: number; guesses: number; overBudget: number };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s);
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

/** The month a date falls in, in the viewer's own time zone. */
export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export const STATUS_LABEL: Record<BudgetStatus, string> = {
  under: 'Under budget',
  near: 'Near limit',
  over: 'Over budget',
};

/** Bar fill percent, clamped for display. The real ratio stays available for text. */
export function barPercent(ratio: number): number {
  if (!Number.isFinite(ratio)) return 100;
  return Math.min(Math.max(Math.round(ratio * 100), 0), 100);
}

/** Summary for the morning-brief Money card (and, later, the phone app). Props in, nothing fetched. */
export interface MoneySummary {
  month: string;
  top: Array<{ id: string; name: string; spentCents: number; budgetCents: number; status: BudgetStatus }>;
  needsYouCount: number;
}

// ---- Money over time (dashboard) ----

export interface PeriodCompare { currentCents: number; previousCents: number | null }
export interface TrendMonth { month: string; outCents: number; inCents: number }
export interface BudgetTrend {
  asOf: string;
  firstDate: string | null;
  months: TrendMonth[];
  monthToDate: PeriodCompare;
  lastMonth: PeriodCompare;
  yearToDate: PeriodCompare;
}

/** A category's name as shown, marked when it is archived. */
export const displayName = (c: { name: string; archived: boolean }): string => (c.archived ? `${c.name} (archived)` : c.name);

/** Today in the viewer's own time zone, as YYYY-MM-DD. */
export function today(now = new Date()): string {
  return `${currentMonth(now)}-${String(now.getDate()).padStart(2, '0')}`;
}

// ---- Assets and debts (Net worth page) ----

export const ASSET_LABELS = { cash: 'Cash', investment: 'Investments', property: 'Property', vehicle: 'Vehicles', other_asset: 'Other assets' } as const;
export const DEBT_LABELS = { credit_card: 'Credit cards', line_of_credit: 'Lines of credit', mortgage: 'Mortgages', loan: 'Loans', other_debt: 'Other debts' } as const;
export type AccountType = keyof typeof ASSET_LABELS | keyof typeof DEBT_LABELS;

export interface BudgetAccount {
  id: string;
  source: 'bank' | 'manual';
  institution: string;
  name: string;
  mask: string | null;
  type: AccountType;
  side: 'asset' | 'debt';
  currency: string;
  balanceCents: number | null;
  asOf: string;
}

export interface NetWorth {
  accounts: BudgetAccount[];
  totals: { assetsCents: number; debtsCents: number; netCents: number; leftOut: number };
}

export interface AccountGroup { type: AccountType; label: string; totalCents: number; accounts: BudgetAccount[] }

/** Whether a balance is part of the totals: the server adds up only Canadian-dollar rows that have one. */
export const counted = (a: BudgetAccount): boolean => a.balanceCents !== null && a.currency === 'CAD';

/** One side of the sheet, grouped by kind in a fixed order, largest balance first within a kind. */
export function groupAccounts(accounts: BudgetAccount[], side: 'asset' | 'debt'): AccountGroup[] {
  const labels: Record<string, string> = side === 'asset' ? ASSET_LABELS : DEBT_LABELS;
  return (Object.keys(labels) as AccountType[]).flatMap(type => {
    const rows = accounts.filter(a => a.side === side && a.type === type).sort((a, b) => (b.balanceCents ?? 0) - (a.balanceCents ?? 0));
    if (rows.length === 0) return [];
    return [{ type, label: labels[type]!, totalCents: rows.filter(counted).reduce((n, a) => n + a.balanceCents!, 0), accounts: rows }];
  });
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
  else if (existing.some(c => c.id !== editingId && !c.archived && c.name.toLowerCase() === name.toLowerCase())) {
    errors.name = 'A category with this name already exists.';
  }
  const cents = parseDollarsToCents(draft.amount);
  if (cents === null) errors.amount = 'Enter an amount like 250 or 250.00.';
  if (errors.name || errors.amount || cents === null) return { ok: false, errors };
  return { ok: true, errors, value: { name, monthlyCents: cents, rollover: draft.rollover } };
}
