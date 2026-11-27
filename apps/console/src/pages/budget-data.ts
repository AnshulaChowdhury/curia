// Data access for the budget pages: the owner-only /api/budget/* routes. Pages never fetch directly.
//
// The server computes the month's summary, so the console, the morning brief and the budget specialist show the same
// numbers; nothing here recalculates spending. A 401 or 403 means "locked": the pages never show partial data.
import { apiFetch } from '../api.js';
import type { AccountType, BudgetCategory, BudgetSummary, BudgetTrend, BudgetTxn, NetWorth } from './budget-utils.js';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export type BudgetLoad<T> =
  | { state: 'ok'; data: T }
  | { state: 'locked' }
  | { state: 'error'; message: string };

export interface ReconcileData {
  month: string;
  categories: BudgetCategory[];
  /** This month's transactions with no category, or a guess the owner has not confirmed. */
  review: BudgetTxn[];
}

export interface DashboardData {
  summary: BudgetSummary;
  netWorth: NetWorth;
  trend: BudgetTrend;
  /** Connected banks that need the owner: a fresh login, or a sync that failed. */
  banksNeedingYou: Array<{ id: string; institution: string; status: 'needs_login' | 'error' }>;
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

  // Archived ones too: the Budgets page lists them, and the review list has to name one a transaction still points at.
  const categories = async () => (await call<{ categories: BudgetCategory[] }>('/api/budget/categories?archived=1')).categories;

  return {
    /** The budgets and what still needs a category in one month. */
    loadBudgets: (month: string) => load<ReconcileData>(async () => {
      const [cats, review] = await Promise.all([
        categories(),
        call<{ transactions: BudgetTxn[] }>(`/api/budget/transactions?month=${encodeURIComponent(month)}&needsReview=true&limit=500`),
      ]);
      return { month, categories: cats, review: review.transactions };
    }),
    /** Everything the dashboard shows: the chosen month, plus net worth, history and bank health as of today. */
    loadDashboard: (month: string, asOf: string) => load<DashboardData>(async () => {
      const [summary, netWorth, trend, banks] = await Promise.all([
        call<BudgetSummary>(`/api/budget/summary?month=${encodeURIComponent(month)}`),
        call<NetWorth>('/api/budget/accounts'),
        call<BudgetTrend>(`/api/budget/trend?asOf=${encodeURIComponent(asOf)}`),
        // Bank connections are optional: without Plaid set up there are simply none to report.
        call<{ links: Array<{ id: string; institution: string; status: string }> }>('/api/budget/banks')
          .catch(err => { console.error('budget bank status failed', err); return { links: [] }; }),
      ]);
      const banksNeedingYou = banks.links.flatMap(l => (l.status === 'needs_login' || l.status === 'error' ? [{ id: l.id, institution: l.institution, status: l.status as 'needs_login' | 'error' }] : []));
      return { summary, netWorth, trend, banksNeedingYou };
    }),
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
    async saveCategory({ id, ...fields }: CategoryInput): Promise<void> {
      if (id) await call(`/api/budget/categories/${encodeURIComponent(id)}`, 'PATCH', fields);
      else await call('/api/budget/categories', 'POST', fields);
    },
    async archiveCategory(id: string): Promise<void> {
      await call(`/api/budget/categories/${encodeURIComponent(id)}/archive`, 'POST');
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
