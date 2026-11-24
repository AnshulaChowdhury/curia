// Thin data-access layer for the budget pages. Pages never fetch directly, so swapping the fixture
// source for the real /api/budget/* routes (owned by web_dev) is a change to this file only.
//
// Owner-only: a 401 or 403 from the server means "locked". The pages show a locked state and never partial data.
import { FIXTURE_CATEGORIES, FIXTURE_TXNS } from './budget-fixtures.js';
import type { BudgetCategory, BudgetTxn } from './budget-utils.js';

export type BudgetLoad =
  | { state: 'ok'; categories: BudgetCategory[]; txns: BudgetTxn[] }
  | { state: 'locked' }
  | { state: 'error'; message: string };

/** Map an HTTP status to a load state. 401 and 403 are treated the same: locked. */
export function stateForStatus(status: number): 'ok' | 'locked' | 'error' {
  if (status === 401 || status === 403) return 'locked';
  return status >= 200 && status < 300 ? 'ok' : 'error';
}

export interface BudgetSource {
  load(): Promise<BudgetLoad>;
  saveCategory(input: { id: string | null; name: string; monthlyCents: number; rollover: boolean }): Promise<BudgetCategory>;
  deleteCategory(id: string): Promise<void>;
}

/** In-memory fixture source. Resets on reload; nothing is persisted or sent anywhere. */
export function createFixtureSource(): BudgetSource {
  let categories = FIXTURE_CATEGORIES.map(c => ({ ...c }));
  const txns = FIXTURE_TXNS.map(t => ({ ...t }));
  let seq = 0;
  return {
    async load() {
      return { state: 'ok', categories: categories.map(c => ({ ...c })), txns: txns.map(t => ({ ...t })) };
    },
    async saveCategory({ id, name, monthlyCents, rollover }) {
      if (id) {
        categories = categories.map(c => (c.id === id ? { ...c, name, monthlyCents, rollover } : c));
        const found = categories.find(c => c.id === id);
        if (!found) throw new Error('Category not found');
        return { ...found };
      }
      seq += 1;
      const created: BudgetCategory = { id: `cat-new-${seq}`, name, monthlyCents, rollover };
      categories = [...categories, created];
      return { ...created };
    },
    async deleteCategory(id) {
      categories = categories.filter(c => c.id !== id);
      for (const t of txns) {
        if (t.categoryId === id) { t.categoryId = null; t.source = 'none'; t.ruleId = null; }
      }
    },
  };
}

/** Module-level source so the Overview and Budgets pages share state during a session. */
export const budgetSource: BudgetSource = createFixtureSource();
