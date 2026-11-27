// Pure logic for the budget dashboard: what the tiles, chart, category bar and lists show. No React, no fetching.
import { counted, displayName, formatCents, type BudgetSummary, type CategorySummary, type NetWorth, type PeriodCompare, type TrendMonth } from './budget-utils.js';

/** Money held in cash accounts: the part of the assets that can be spent today. */
export function cashCents(netWorth: NetWorth): number {
  return netWorth.accounts.filter(a => a.type === 'cash' && counted(a)).reduce((n, a) => n + a.balanceCents!, 0);
}

export interface Change { percent: number; up: boolean }

/** Spending change against the earlier period, or null when there is nothing to compare with. */
export function change(c: PeriodCompare): Change | null {
  if (c.previousCents === null || c.previousCents === 0) return null;
  const percent = ((c.currentCents - c.previousCents) / c.previousCents) * 100;
  return { percent: Math.abs(percent), up: percent > 0 };
}

export type Range = 'ytd' | '12m' | 'all';

export function inRange(months: TrendMonth[], range: Range, asOf: string): TrendMonth[] {
  if (range === 'ytd') return months.filter(m => m.month.startsWith(asOf.slice(0, 4)));
  return range === '12m' ? months.slice(-12) : months;
}

/** Up to five round gridline values from zero that cover the largest amount (in cents). */
export function axisTicks(maxCents: number): number[] {
  const max = Math.max(maxCents, 100_00);
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw)!;
  const ticks = [0];
  while (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** "$5K", "$1.5M": short axis labels. */
export function shortMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${+(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${+(dollars / 1_000).toFixed(1)}K`;
  return `$${Math.round(dollars)}`;
}

/**
 * An SVG path through the points that curves smoothly without overshooting (monotone cubic), so the line never dips
 * below a value that was not there.
 */
export function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  const n = points.length;
  const slope = points.slice(1).map(([x, y], i) => (y - points[i]![1]) / (x - points[i]![0]));
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0] ?? 0;
    if (i === n - 1) return slope[n - 2]!;
    const [a, b] = [slope[i - 1]!, slope[i]!];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b); // harmonic mean: flat at peaks, never past a neighbour
  });
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [[x0, y0], [x1, y1]] = [points[i]!, points[i + 1]!];
    const h = (x1 - x0) / 3;
    d += ` C${x0 + h},${y0 + tangent[i]! * h} ${x1 - h},${y1 - tangent[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}

/** Colour slots available before the rest fold into "Other". */
export const SLOTS = 8;

export interface Segment { key: string; label: string; cents: number; slot: number | 'other' | 'none' }

/**
 * The month's spending split by category. A category's colour follows its place in the list, not its size, so it keeps
 * the same colour from month to month.
 */
export function categorySegments(summary: BudgetSummary): Segment[] {
  const segments: Segment[] = [];
  let other = 0;
  summary.categories.forEach((c, i) => {
    if (c.spentCents <= 0) return;
    if (i < SLOTS) segments.push({ key: c.categoryId, label: displayName(c), cents: c.spentCents, slot: i + 1 });
    else other += c.spentCents;
  });
  if (other > 0) segments.push({ key: 'other', label: 'Other categories', cents: other, slot: 'other' });
  const loose = summary.totals.uncategorisedSpentCents;
  if (loose > 0) segments.push({ key: 'none', label: 'No category', cents: loose, slot: 'none' });
  return segments;
}

export interface ActionItem { key: string; tone: 'bad' | 'warn'; strong: string; rest: string; href: string; action: string }

export function actionItems(input: {
  summary: BudgetSummary;
  netWorth: NetWorth;
  banks: Array<{ id: string; institution: string; status: 'needs_login' | 'error' }>;
}): ActionItem[] {
  const { summary, netWorth, banks } = input;
  const items: ActionItem[] = [];
  const reconcile = `/budget/budgets?month=${summary.month}`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  for (const b of banks) {
    items.push({ key: `bank-${b.id}`, tone: 'bad', strong: b.institution, rest: b.status === 'needs_login' ? 'needs you to log in again' : 'failed to sync', href: '#bud-add', action: 'Fix connection' });
  }
  const { uncategorised, guesses } = summary.needsYou;
  if (uncategorised > 0) items.push({ key: 'loose', tone: 'bad', strong: plural(uncategorised, 'transaction'), rest: `${uncategorised === 1 ? 'has' : 'have'} no category`, href: reconcile, action: 'Categorise' });
  if (guesses > 0) items.push({ key: 'guess', tone: 'warn', strong: `${guesses} guess${guesses === 1 ? '' : 'es'}`, rest: 'to confirm', href: reconcile, action: 'Review' });
  const over = summary.categories.filter(c => c.state === 'over' && !c.archived);
  if (over.length > 0) {
    const by = over.reduce((n, c) => n - (c.remainingCents ?? 0), 0);
    items.push({ key: 'over', tone: 'bad', strong: `${over.length} categor${over.length === 1 ? 'y' : 'ies'}`, rest: `over budget by ${formatCents(by)}`, href: '/budget/budgets', action: 'Adjust budgets' });
  }
  if (!summary.categories.some(c => !c.archived && c.budgetedCents !== null)) {
    items.push({ key: 'nobudget', tone: 'warn', strong: 'No budgets yet', rest: 'so nothing can be tracked against a plan', href: '/budget/budgets', action: 'Set budgets' });
  }
  if (netWorth.accounts.length === 0) {
    items.push({ key: 'nobalances', tone: 'warn', strong: 'No balances yet', rest: 'so net worth is unknown', href: '#bud-networth', action: 'Add balances' });
  } else if (netWorth.totals.leftOut > 0) {
    items.push({ key: 'leftout', tone: 'warn', strong: plural(netWorth.totals.leftOut, 'account'), rest: 'not counted in net worth', href: '#bud-networth', action: 'See which' });
  }
  return items;
}

export type Column = 'over' | 'near' | 'under';

export function columnOf(summary: BudgetSummary, column: Column): { categories: CategorySummary[]; spentCents: number; budgetedCents: number } {
  // Over: worst first. The others: closest to their limit first.
  const share = (c: CategorySummary) => (c.budgetedCents ? c.spentCents / c.budgetedCents : 0);
  const categories = summary.categories.filter(c => c.state === column)
    .sort((a, b) => (column === 'over' ? (a.remainingCents ?? 0) - (b.remainingCents ?? 0) : share(b) - share(a)));
  return {
    categories,
    spentCents: categories.reduce((n, c) => n + c.spentCents, 0),
    budgetedCents: categories.reduce((n, c) => n + (c.budgetedCents ?? 0), 0),
  };
}
