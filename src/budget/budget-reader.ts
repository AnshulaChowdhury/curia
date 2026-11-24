// budget-reader.ts — what the budget specialist (agents/budget.yaml) may read, and nothing it may change.
//
// A read-only facade over BudgetStore. It has no method that sets a category, edits a budget, imports a file or touches the
// rules, so the specialist is read-only by design (ADR-062): the only way to add a write is to add a method here and change
// the ADR. Amounts leave here in dollars (a model cannot convert cents reliably); payee and description are bank text and
// are returned as data only.

import type { BudgetStore, BudgetTransaction } from './budget-store.js';

type Store = Pick<BudgetStore, 'summary' | 'listTransactions' | 'listCategories'>;

const dollars = (cents: number): number => Math.round(cents) / 100;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface BudgetSummaryForAgent {
  month: string;
  currency: 'CAD';
  categories: Array<{ name: string; budgeted: number | null; spent: number; remaining: number | null; state: 'no_budget' | 'under' | 'near' | 'over' }>;
  totals: { budgeted: number; spent: number; spentOnUncategorised: number };
  needsYou: { uncategorised: number; guesses: number; overBudget: number };
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

export class BudgetReader {
  constructor(private readonly store: Store) {}

  async summary(month: string): Promise<BudgetSummaryForAgent> {
    if (!MONTH.test(month)) throw new Error('month must be YYYY-MM');
    const s = await this.store.summary(month);
    return {
      month: s.month,
      currency: 'CAD',
      categories: s.categories.map(c => ({
        name: c.name,
        budgeted: c.budgetedCents === null ? null : dollars(c.budgetedCents),
        spent: dollars(c.spentCents),
        remaining: c.remainingCents === null ? null : dollars(c.remainingCents),
        state: c.state,
      })),
      totals: { budgeted: dollars(s.totals.budgetedCents), spent: dollars(s.totals.spentCents), spentOnUncategorised: dollars(s.totals.uncategorisedSpentCents) },
      needsYou: s.needsYou,
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
      categoryId = (await this.store.listCategories()).find(c => c.name.toLowerCase() === wanted)?.id;
      if (!categoryId) return { transactions: [] };
    }
    return { transactions: await this.shape({ month: filter.month, categoryId, limit: this.clamp(filter.limit, 25) }) };
  }

  private clamp(n: number | undefined, fallback: number): number {
    return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n as number)), 50) : fallback;
  }

  private async shape(filter: Parameters<Store['listTransactions']>[0]): Promise<BudgetTransactionForAgent[]> {
    const [rows, categories] = await Promise.all([this.store.listTransactions(filter), this.store.listCategories()]);
    const names = new Map(categories.map(c => [c.id, c.name]));
    return rows.map((t: BudgetTransaction) => ({
      date: t.date, account: t.account, payee: t.payee, description: t.description, amount: dollars(t.amountCents),
      category: t.categoryId ? (names.get(t.categoryId) ?? null) : null, categorisedBy: t.source,
    }));
  }
}
