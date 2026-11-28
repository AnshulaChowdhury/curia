// projection.ts — where net worth is heading if the budget holds, including changes still waiting to be approved.
//
// The one place this is worked out, so the proposal card and the budget specialist always show the same figures. The
// starting point is today's net worth from the account balances. Each following month adds income and takes away
// expenses. Savings, which covers paying down debt, is money kept, so it takes nothing away. Interest, investment
// growth and changes in property value are not estimated.

import { monthsFrom, MAX_PLAN_MONTHS, type BudgetPlan, type BudgetStore, type CategoryKind } from './budget-store.js';
import type { AccountStore, NetWorth } from './accounts-store.js';
import type { ProposedRow } from './proposal-store.js';
import { monthOf } from './month.js';

export interface ProjectedMonth {
  month: string;
  incomeCents: number;
  expenseCents: number;
  /** Total of income less expenses from the first projected month through this one. */
  changeCents: number;
  /** Net worth at the end of the month; null when there is no balance to start from. */
  netWorthCents: number | null;
  /** Nothing at all is budgeted this month, so it adds nothing. */
  empty: boolean;
}

export interface Projection {
  today: { netWorthCents: number; assetsCents: number; debtsCents: number } | null;
  /** Accounts with no Canadian-dollar balance, which today's figure leaves out. */
  leftOut: number;
  /** Starts with next month: this month's money is already partly in today's balances. */
  months: ProjectedMonth[];
}

type PlanMonth = Map<string, { kind: CategoryKind; cents: Array<number | null> }>;

/** The plan as it would be with the proposed rows applied. A cleared amount leaves the month as it is. */
function withProposed(plan: BudgetPlan, rows: ProposedRow[]): PlanMonth {
  const result: PlanMonth = new Map(plan.categories.map(c => [c.categoryId, { kind: c.kind, cents: c.amounts.map(a => a.cents) }]));
  rows.forEach((row, index) => {
    const key = row.categoryId ?? `new ${index}`;
    if (row.action === 'archive') { result.delete(key); return; }
    const entry = result.get(key) ?? { kind: row.kind, cents: plan.months.map(() => null as number | null) };
    entry.kind = row.kind;
    for (const a of row.amounts) {
      const at = plan.months.indexOf(a.month);
      if (at >= 0 && a.cents !== null) entry.cents[at] = a.cents;
    }
    result.set(key, entry);
  });
  return result;
}

export function project(netWorth: NetWorth, plan: BudgetPlan, rows: ProposedRow[] = []): Projection {
  const { assetsCents, debtsCents, netCents, leftOut } = netWorth.totals;
  // With nothing counted there is no starting point; zero would read as a real figure.
  const today = netWorth.accounts.length > leftOut ? { netWorthCents: netCents, assetsCents, debtsCents } : null;
  const categories = [...withProposed(plan, rows).values()];
  let changeCents = 0;
  const months = plan.months.map((month, at) => {
    const sum = (kind: CategoryKind) => categories.reduce((n, c) => n + (c.kind === kind ? c.cents[at] ?? 0 : 0), 0);
    const incomeCents = sum('income');
    const expenseCents = sum('expense');
    changeCents += incomeCents - expenseCents;
    return {
      month, incomeCents, expenseCents, changeCents,
      netWorthCents: today ? today.netWorthCents + changeCents : null,
      empty: categories.every(c => c.cents[at] === null),
    };
  });
  return { today, leftOut, months };
}

export class NetWorthProjector {
  constructor(
    private readonly budget: Pick<BudgetStore, 'plan'>,
    private readonly accounts: Pick<AccountStore, 'summary'>,
    private readonly timezone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private nextMonth(): string {
    return monthsFrom(monthOf(undefined, this.timezone, this.now())!, 2)[1]!;
  }

  private async run(count: number, rows: ProposedRow[]): Promise<Projection> {
    const [plan, netWorth] = await Promise.all([
      this.budget.plan(this.nextMonth(), Math.min(Math.max(1, Math.floor(count)), MAX_PLAN_MONTHS)),
      this.accounts.summary(),
    ]);
    return project(netWorth, plan, rows);
  }

  /** The budget as it stands, for the next `months` months. */
  current(months = 6): Promise<Projection> {
    return this.run(Number.isFinite(months) ? months : 6, []);
  }

  /** The budget with these changes, through the last month they name (six months when they name none ahead). */
  forRows(rows: ProposedRow[]): Promise<Projection> {
    const first = this.nextMonth();
    const last = rows.flatMap(r => r.amounts.map(a => a.month)).filter(m => m >= first).sort().at(-1);
    const upTo = last ? monthsFrom(first, MAX_PLAN_MONTHS).indexOf(last) + 1 : 6;
    // Past the longest span shown, indexOf finds nothing: show that longest span.
    return this.run(upTo > 0 ? upTo : MAX_PLAN_MONTHS, rows);
  }
}
