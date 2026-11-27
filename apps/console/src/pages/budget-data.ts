// Data access for the budget pages: the owner-only /api/budget/* routes. Pages never fetch directly.
//
// The server computes the month's summary, so the console, the morning brief and the budget specialist show the same
// numbers; nothing here recalculates spending. A 401 or 403 means "locked": the pages never show partial data.
import { apiFetch } from '../api.js';
import type { AccountType, BudgetCategory, BudgetSummary, BudgetTxn, NetWorth } from './budget-utils.js';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export type BudgetLoad<T> =
  | { state: 'ok'; data: T }
  | { state: 'locked' }
  | { state: 'error'; message: string };

export interface MonthData {
  categories: BudgetCategory[];
  summary: BudgetSummary;
  /** This month's transactions with no category, or a guess the owner has not confirmed. */
  review: BudgetTxn[];
}

export interface AccountInput { id: string | null; name: string; type: AccountType; balanceCents: number }

export interface CategoryInput { id: string | null; name: string; monthlyCents: number; rollover: boolean }

/** Map an HTTP status to a load state. 401 and 403 are treated the same: locked. */
export function stateForStatus(status: number): 'ok' | 'locked' | 'error' {
  if (status === 401 || status === 403) return 'locked';
  return status >= 200 && status < 300 ? 'ok' : 'error';
}

class RequestFailed extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function createBudgetClient(f: Fetcher = apiFetch) {
  async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await f(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const reply = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new RequestFailed(typeof reply?.error === 'string' ? reply.error : 'Something went wrong.', res.status);
    }
    return (await res.json()) as T;
  }

  async function load<T>(read: () => Promise<T>): Promise<BudgetLoad<T>> {
    try {
      return { state: 'ok', data: await read() };
    } catch (e) {
      if (e instanceof RequestFailed && stateForStatus(e.status) === 'locked') return { state: 'locked' };
      console.error('budget load failed', e);
      return { state: 'error', message: 'Could not load the budget.' };
    }
  }

  const categories = async () => (await call<{ categories: BudgetCategory[] }>('/api/budget/categories')).categories;

  return {
    loadCategories: () => load(categories),
    loadNetWorth: () => load(() => call<NetWorth>('/api/budget/accounts')),
    async saveAccount({ id, ...fields }: AccountInput): Promise<void> {
      if (id) await call(`/api/budget/accounts/${encodeURIComponent(id)}`, 'PUT', fields);
      else await call('/api/budget/accounts', 'POST', fields);
    },
    async deleteAccount(id: string): Promise<void> {
      await call(`/api/budget/accounts/${encodeURIComponent(id)}`, 'DELETE');
    },
    /** Syncs every connected bank, which also brings the latest balances. */
    async refreshBanks(): Promise<void> {
      await call('/api/budget/banks/sync', 'POST');
    },
    loadMonth: (month: string) => load<MonthData>(async () => {
      const m = encodeURIComponent(month);
      const [cats, summary, review] = await Promise.all([
        categories(),
        call<BudgetSummary>(`/api/budget/summary?month=${m}`),
        call<{ transactions: BudgetTxn[] }>(`/api/budget/transactions?month=${m}&needsReview=true&limit=500`),
      ]);
      return { categories: cats, summary, review: review.transactions };
    }),
    async saveCategory({ id, ...fields }: CategoryInput): Promise<void> {
      if (id) await call(`/api/budget/categories/${encodeURIComponent(id)}`, 'PATCH', fields);
      else await call('/api/budget/categories', 'POST', fields);
    },
    async deleteCategory(id: string): Promise<void> {
      await call(`/api/budget/categories/${encodeURIComponent(id)}`, 'DELETE');
    },
    async categorise(transactionId: string, categoryId: string | null): Promise<void> {
      await call(`/api/budget/transactions/${encodeURIComponent(transactionId)}`, 'PATCH', { categoryId });
    },
  };
}

export const budgetClient = createBudgetClient();
