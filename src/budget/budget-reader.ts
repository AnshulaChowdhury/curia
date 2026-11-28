// budget-reader.ts — what the budget specialist (agents/budget.yaml) may read, and nothing it may change.
//
// A read-only facade over BudgetStore. It has no method that sets a category, edits a budget, imports a file or touches the
// rules, so the specialist is read-only by design (ADR-062): the only way to add a write is to add a method here and change
// the ADR. Amounts leave here in dollars (a model cannot convert cents reliably); payee and description are bank text and
// are returned as data only.

import type { BudgetStore, BudgetTransaction, CategoryKind } from './budget-store.js';
import type { NetWorthProjector, Projection } from './projection.js';

type Store = Pick<BudgetStore, 'summary' | 'plan' | 'listTransactions' | 'listCategories'>;

const dollars = (cents: number): number => Math.round(cents) / 100;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface BudgetSummaryForAgent {
  month: string;
  currency: 'CAD';
  categories: Array<{ name: string; archived?: true; budgeted: number | null; spent: number; remaining: number | null; state: 'no_budget' | 'under' | 'near' | 'over' }>;
  totals: { budgeted: number; spent: number; spentOnUncategorised: number };
  needsYou: { uncategorised: number; guesses: number; overBudget: number };
}

export interface BudgetPlanForAgent {
  currency: 'CAD';
  months: string[];
  /** Every open category, with its budget in dollars for each month (null: none set). */
  categories: Array<{ name: string; type: CategoryKind; amounts: Record<string, number | null> }>;
}

export interface BudgetTransactionForAgent {
  date: string;
  account: string;
  payee: string;
  description: string;
  /** Negative = money out. */
  amount: number;
  category: string | null;
  categorisedBy: 'rule' | 'agent_guess' | 'you' | null;
}

export interface ProjectionForAgent {
  currency: 'CAD';
  /** From the account balances on the Overview; null when there are none. */
  today: { netWorth: number; assets: number; debts: number } | null;
  accountsLeftOut: number;
  months: Array<{ month: string; income: number; expenses: number; changeFromToday: number; netWorthAtMonthEnd: number | null; nothingBudgeted?: true }>;
  assumptions: string;
}

export const PROJECTION_ASSUMPTIONS =
  'Today\'s balances plus income minus expenses, from next month. Savings and debt repayment are money kept. No interest, investment growth or change in property value.';

export function projectionForAgent(p: Projection): ProjectionForAgent {
  return {
    currency: 'CAD',
    today: p.today && { netWorth: dollars(p.today.netWorthCents), assets: dollars(p.today.assetsCents), debts: dollars(p.today.debtsCents) },
    accountsLeftOut: p.leftOut,
    months: p.months.map(m => ({
      month: m.month, income: dollars(m.incomeCents), expenses: dollars(m.expenseCents), changeFromToday: dollars(m.changeCents),
      netWorthAtMonthEnd: m.netWorthCents === null ? null : dollars(m.netWorthCents), ...(m.empty ? { nothingBudgeted: true as const } : {}),
    })),
    assumptions: PROJECTION_ASSUMPTIONS,
  };
}

export class BudgetReader {
  constructor(private readonly store: Store, private readonly projector?: Pick<NetWorthProjector, 'current'>) {}

  /** Net worth today and where the budget as it stands takes it. Totals only: no account is named. */
  async netWorth(months = 6): Promise<ProjectionForAgent> {
    if (!this.projector) throw new Error('Net worth is not available');
    return projectionForAgent(await this.projector.current(months));
  }

  async summary(month: string): Promise<BudgetSummaryForAgent> {
    if (!MONTH.test(month)) throw new Error('month must be YYYY-MM');
    const s = await this.store.summary(month);
    return {
      month: s.month,
      currency: 'CAD',
      categories: s.categories.map(c => ({
        name: c.name,
        ...(c.archived ? { archived: true as const } : {}),
        budgeted: c.budgetedCents === null ? null : dollars(c.budgetedCents),
        spent: dollars(c.spentCents),
        remaining: c.remainingCents === null ? null : dollars(c.remainingCents),
        state: c.state,
      })),
      totals: { budgeted: dollars(s.totals.budgetedCents), spent: dollars(s.totals.spentCents), spentOnUncategorised: dollars(s.totals.uncategorisedSpentCents) },
      needsYou: s.needsYou,
    };
  }

  /** What is budgeted month by month, income and savings as well as spending. */
  async plan(from: string, months = 6): Promise<BudgetPlanForAgent> {
    if (!MONTH.test(from)) throw new Error('month must be YYYY-MM');
    const p = await this.store.plan(from, Number.isFinite(months) ? Math.min(Math.max(1, Math.floor(months)), 24) : 6);
    return {
      currency: 'CAD',
      months: p.months,
      categories: p.categories.map(c => ({
        name: c.name,
        type: c.kind,
        amounts: Object.fromEntries(p.months.map((m, i) => { const cents = c.amounts[i]?.cents ?? null; return [m, cents === null ? null : dollars(cents)]; })),
      })),
    };
  }

  /** Transactions the owner has not settled: uncategorised, or categorised only by a guess. */
  async needsReview(limit = 20): Promise<{ transactions: BudgetTransactionForAgent[] }> {
    return { transactions: await this.shape({ needsReview: true, limit: this.clamp(limit, 20) }) };
  }

  async transactions(filter: { month: string; category?: string; limit?: number }): Promise<{ transactions: BudgetTransactionForAgent[] }> {
    if (!MONTH.test(filter.month)) throw new Error('month must be YYYY-MM');
    let categoryId: string | undefined;
    if (filter.category) {
      const wanted = filter.category.trim().toLowerCase();
      // Open categories are listed first, so a reused name finds the open one.
      categoryId = (await this.store.listCategories({ includeArchived: true })).find(c => c.name.toLowerCase() === wanted)?.id;
      if (!categoryId) return { transactions: [] };
    }
    return { transactions: await this.shape({ month: filter.month, categoryId, limit: this.clamp(filter.limit, 25) }) };
  }

  private clamp(n: number | undefined, fallback: number): number {
    return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n as number)), 50) : fallback;
  }

  private async shape(filter: Parameters<Store['listTransactions']>[0]): Promise<BudgetTransactionForAgent[]> {
    const [rows, categories] = await Promise.all([this.store.listTransactions(filter), this.store.listCategories({ includeArchived: true })]);
    const names = new Map(categories.map(c => [c.id, c.archived ? `${c.name} (archived)` : c.name]));
    return rows.map((t: BudgetTransaction) => ({
      date: t.date, account: t.account, payee: t.payee, description: t.description, amount: dollars(t.amountCents),
      category: t.categoryId ? (names.get(t.categoryId) ?? null) : null, categorisedBy: t.source,
    }));
  }
}
