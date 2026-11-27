// budget-store.ts — personal budgeting: categories with monthly budgets, transactions, and the one summary every screen uses.
//
// Owner-only data. The console, the morning brief and the budget specialist all read the same `summary()`, so they can
// never disagree. Amounts are integer cents (negative = money out). Payee and description are untrusted bank text: they
// are stored and returned as plain strings and only ever rendered as text.

import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import type { DbPool } from '../db/connection.js';

export type CategorisedBy = 'rule' | 'agent_guess' | 'you';

export const CATEGORY_KINDS = ['expense', 'income', 'savings'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** Budgets month by month: for each open category, what is budgeted in each of `months`. */
export interface BudgetPlan {
  months: string[];
  categories: Array<{
    categoryId: string;
    name: string;
    kind: CategoryKind;
    /** One per month, in order. `own` is true when the month has its own amount rather than the usual one. */
    amounts: Array<{ cents: number | null; own: boolean }>;
  }>;
}

export const MAX_PLAN_MONTHS = 24;

export interface BudgetCategory {
  id: string;
  name: string;
  kind: CategoryKind;
  monthlyCents: number | null;
  rollover: boolean;
  sortOrder: number;
  /** Archived: its transactions keep it, and nothing new can be put in it. */
  archived: boolean;
  transactionCount: number;
}

export interface BudgetTransaction {
  id: string;
  account: string;
  date: string;
  payee: string;
  description: string;
  amountCents: number;
  categoryId: string | null;
  source: CategorisedBy | null;
  ruleId: string | null;
  confidence: number | null;
}

export interface NewTransaction {
  account: string;
  date: string;
  payee: string;
  description: string;
  amountCents: number;
  categoryId?: string | null;
  source?: CategorisedBy | null;
  ruleId?: string | null;
  confidence?: number | null;
  /** The bank's own id for the transaction (Plaid), so two identical purchases on one day stay two rows. */
  externalId?: string;
}

export interface CategorySummary {
  categoryId: string;
  name: string;
  /** Listed only in months where it has transactions. */
  archived: boolean;
  budgetedCents: number | null;
  spentCents: number;
  /** budgeted - spent; null when no budget is set. Negative when over. */
  remainingCents: number | null;
  state: 'no_budget' | 'under' | 'near' | 'over';
}

export interface BudgetSummary {
  month: string;
  categories: CategorySummary[];
  totals: { budgetedCents: number; spentCents: number; uncategorisedSpentCents: number };
  needsYou: { uncategorised: number; guesses: number; overBudget: number };
}

export interface PeriodCompare {
  /** Money out in the period, in cents. */
  currentCents: number;
  /** The same period one step earlier; null when the stored history does not reach back that far. */
  previousCents: number | null;
}

export interface BudgetTrend {
  asOf: string;
  /** The date of the oldest stored transaction, or null when there are none. */
  firstDate: string | null;
  /** Up to 24 months ending with asOf's month, starting no earlier than the first transaction. */
  months: Array<{ month: string; outCents: number; inCents: number }>;
  monthToDate: PeriodCompare;
  lastMonth: PeriodCompare;
  yearToDate: PeriodCompare;
}

const isoDay = (y: number, m0: number, d: number): string => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
/** The same day of the month in another month, held to that month's last day (31 March -> 28 February). */
const clampedDay = (y: number, m0: number, d: number): string => isoDay(y, m0, Math.min(d, new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate()));

export interface TransactionFilter {
  month?: string;
  categoryId?: string;
  account?: string;
  needsReview?: boolean;
  limit?: number;
}

/** The caller did something not allowed: a bad value, a missing row, a name already in use. */
export class BudgetError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'not_found' | 'conflict' = 'invalid') {
    super(message);
  }
}

export const MAX_RULES_BYTES = 64 * 1024;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NEAR_FRACTION = 0.85;
const MAX_CENTS = 2_000_000_000;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_CENTS;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function fingerprint(t: Pick<NewTransaction, 'account' | 'date' | 'payee' | 'description' | 'amountCents' | 'externalId'>): string {
  const parts = [t.account, t.date, t.amountCents, t.payee, t.description];
  // Appended only when present, so every fingerprint already stored (file imports) stays the same.
  if (t.externalId) parts.push(t.externalId);
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** [first day, first day of the next month) for a YYYY-MM month. */
function monthBounds(month: string): { start: string; end: string } {
  if (!MONTH.test(month)) throw new BudgetError('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: `${month}-01`, end: `${next}-01` };
}

export function stateFor(budgeted: number | null, spent: number): CategorySummary['state'] {
  if (budgeted === null) return 'no_budget';
  if (spent > budgeted) return 'over';
  return budgeted > 0 && spent >= budgeted * NEAR_FRACTION ? 'near' : 'under';
}

interface CategoryRow { id: string; name: string; kind: CategoryKind; monthly_cents: number | null; rollover: boolean; sort_order: number; archived_at?: Date | null; transactions?: string }
interface TxnRow {
  id: string; account: string; txn_date: string; payee: string; description: string; amount_cents: number;
  category_id: string | null; source: CategorisedBy | null; rule_id: string | null; confidence: string | null;
}

const toCategory = (r: CategoryRow): BudgetCategory => ({
  id: r.id, name: r.name, kind: r.kind, monthlyCents: r.monthly_cents, rollover: r.rollover, sortOrder: r.sort_order,
  archived: r.archived_at != null, transactionCount: Number(r.transactions ?? 0),
});
/** Every column toCategory reads, for a RETURNING clause on budget_categories. */
const CATEGORY_COLUMNS = `id, name, kind, monthly_cents, rollover, sort_order, archived_at,
  (SELECT count(*) FROM budget_transactions t WHERE t.category_id = budget_categories.id)::text AS transactions`;

/** The database trigger refusing a new assignment to an archived category, as the caller's error. */
const archivedConflict = (err: unknown): unknown =>
  (err as { constraint?: string }).constraint === 'budget_category_archived' ? new BudgetError('That category is archived', 'conflict') : err;
/** `count` months starting at `from`. */
export function monthsFrom(from: string, count: number): string[] {
  if (!MONTH.test(from)) throw new BudgetError('month must be YYYY-MM');
  const [y, m] = from.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => isoDay(y, m - 1 + i, 1).slice(0, 7));
}

function kindOf(v: unknown): CategoryKind {
  if (!CATEGORY_KINDS.includes(v as CategoryKind)) throw new BudgetError('The type must be expense, income or savings');
  return v as CategoryKind;
}

const toTxn = (r: TxnRow): BudgetTransaction => ({
  id: r.id, account: r.account, date: r.txn_date, payee: r.payee, description: r.description, amountCents: r.amount_cents,
  categoryId: r.category_id, source: r.source, ruleId: r.rule_id, confidence: r.confidence === null ? null : Number(r.confidence),
});
const TXN_COLUMNS = `id, account, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, payee, description, amount_cents, category_id, source, rule_id, confidence`;

export class BudgetStore {
  constructor(private readonly pool: DbPool) {}

  // -- categories ------------------------------------------------------------------------------------------------

  /** The open categories; with `includeArchived`, the archived ones too, after them. */
  async listCategories(options: { includeArchived?: boolean } = {}): Promise<BudgetCategory[]> {
    const { rows } = await this.pool.query<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM budget_categories ${options.includeArchived ? '' : 'WHERE archived_at IS NULL'}
       ORDER BY (archived_at IS NOT NULL), sort_order, lower(name)`,
    );
    return rows.map(toCategory);
  }

  async createCategory(input: { name?: unknown; kind?: unknown; monthlyCents?: unknown; rollover?: unknown }): Promise<BudgetCategory> {
    const name = text(input.name, 60);
    if (!name) throw new BudgetError('A category needs a name');
    const monthlyCents = this.cents(input.monthlyCents);
    const kind = input.kind === undefined ? 'expense' : kindOf(input.kind);
    try {
      const { rows } = await this.pool.query<CategoryRow>(
        `INSERT INTO budget_categories (name, monthly_cents, rollover, kind, sort_order)
         VALUES ($1, $2, $3, $4, COALESCE((SELECT max(sort_order) + 1 FROM budget_categories), 0))
         RETURNING ${CATEGORY_COLUMNS}`,
        [name, monthlyCents, input.rollover === true, kind],
      );
      return toCategory(rows[0]!);
    } catch (err) {
      throw this.nameConflict(err);
    }
  }

  async updateCategory(id: string, input: { name?: unknown; kind?: unknown; monthlyCents?: unknown; rollover?: unknown }): Promise<BudgetCategory> {
    const sets: string[] = [];
    const args: unknown[] = [id];
    if (input.name !== undefined) {
      const name = text(input.name, 60);
      if (!name) throw new BudgetError('A category needs a name');
      args.push(name); sets.push(`name = $${args.length}`);
    }
    if (input.monthlyCents !== undefined) { args.push(this.cents(input.monthlyCents)); sets.push(`monthly_cents = $${args.length}`); }
    if (input.rollover !== undefined) { args.push(input.rollover === true); sets.push(`rollover = $${args.length}`); }
    if (input.kind !== undefined) { args.push(kindOf(input.kind)); sets.push(`kind = $${args.length}`); }
    if (sets.length === 0) throw new BudgetError('Nothing to change');
    try {
      const { rows } = await this.pool.query<CategoryRow>(
        `UPDATE budget_categories SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND archived_at IS NULL
         RETURNING ${CATEGORY_COLUMNS}`,
        args,
      );
      if (!rows[0]) throw new BudgetError('No such category', 'not_found');
      return toCategory(rows[0]);
    } catch (err) {
      throw this.nameConflict(err);
    }
  }

  /** Closes a category to new transactions. The ones it has stay, so past months still add up. */
  async archiveCategory(id: string): Promise<BudgetCategory> {
    const { rows } = await this.pool.query<CategoryRow>(
      `UPDATE budget_categories SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING ${CATEGORY_COLUMNS}`,
      [id],
    );
    if (!rows[0]) throw new BudgetError('No such category', 'not_found');
    return toCategory(rows[0]);
  }

  /** Removes a category that has no transactions. One that has any can only be archived. */
  async deleteCategory(id: string): Promise<void> {
    const used = new BudgetError('This category has transactions. Archive it instead.', 'conflict');
    try {
      const done = await this.pool.query(
        `DELETE FROM budget_categories c WHERE c.id = $1 AND NOT EXISTS (SELECT 1 FROM budget_transactions t WHERE t.category_id = c.id)`,
        [id],
      );
      if (done.rowCount) return;
    } catch (err) {
      // A transaction landed in it between the check and the delete: the foreign key refuses.
      if ((err as { code?: string }).code === '23503') throw used;
      throw err;
    }
    const there = await this.pool.query('SELECT 1 FROM budget_categories WHERE id = $1', [id]);
    throw there.rowCount ? used : new BudgetError('No such category', 'not_found');
  }

  // -- budgets by month -----------------------------------------------------------------------------------------

  /** Sets one month's budget for an open category; null goes back to the usual monthly amount. */
  async setMonthAmount(id: string, month: string, cents: unknown): Promise<void> {
    if (!MONTH.test(month)) throw new BudgetError('month must be YYYY-MM');
    const value = this.cents(cents);
    const open = await this.pool.query('SELECT 1 FROM budget_categories WHERE id = $1 AND archived_at IS NULL', [id]);
    if (!open.rowCount) throw new BudgetError('No such category', 'not_found');
    if (value === null) await this.pool.query('DELETE FROM budget_month_amounts WHERE category_id = $1 AND month = $2', [id, month]);
    else {
      await this.pool.query(
        `INSERT INTO budget_month_amounts (category_id, month, cents) VALUES ($1, $2, $3)
         ON CONFLICT (category_id, month) DO UPDATE SET cents = EXCLUDED.cents`,
        [id, month, value],
      );
    }
  }

  async plan(from: string, count = 6): Promise<BudgetPlan> {
    if (!Number.isInteger(count) || count < 1 || count > MAX_PLAN_MONTHS) throw new BudgetError(`Choose between 1 and ${MAX_PLAN_MONTHS} months`);
    const months = monthsFrom(from, count);
    const [categories, own] = await Promise.all([
      this.listCategories(),
      this.pool.query<{ category_id: string; month: string; cents: number }>(
        'SELECT category_id, month, cents FROM budget_month_amounts WHERE month >= $1 AND month <= $2', [months[0], months[months.length - 1]]),
    ]);
    const set = new Map(own.rows.map(r => [`${r.category_id} ${r.month}`, r.cents]));
    return {
      months,
      categories: categories.map(c => ({
        categoryId: c.id, name: c.name, kind: c.kind,
        amounts: months.map(month => {
          const cents = set.get(`${c.id} ${month}`);
          return cents === undefined ? { cents: c.monthlyCents, own: false } : { cents, own: true };
        }),
      })),
    };
  }

  private cents(v: unknown): number | null {
    if (v === undefined || v === null) return null;
    if (!isInt(v) || v < 0) throw new BudgetError('monthlyCents must be a whole number of cents, zero or more');
    return v;
  }

  private nameConflict(err: unknown): unknown {
    return (err as { code?: string }).code === '23505' ? new BudgetError('A category with that name already exists', 'conflict') : err;
  }

  // -- transactions ----------------------------------------------------------------------------------------------

  /** Adds transactions, skipping any already stored. Returns how many were added and how many were duplicates. */
  async addTransactions(items: NewTransaction[]): Promise<{ added: number; duplicates: number }> {
    let added = 0;
    for (const t of items) {
      if (!DAY.test(t.date) || !isInt(t.amountCents) || !text(t.account, 60)) throw new BudgetError('A transaction needs an account, a YYYY-MM-DD date and whole cents');
      const res = await this.pool.query(
        `INSERT INTO budget_transactions (account, txn_date, payee, description, amount_cents, category_id, source, rule_id, confidence, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (fingerprint) DO NOTHING`,
        [text(t.account, 60), t.date, text(t.payee, 200), text(t.description, 500), t.amountCents,
          t.categoryId ?? null, t.categoryId ? (t.source ?? 'you') : null, t.categoryId ? (t.ruleId ?? null) : null, t.categoryId ? (t.confidence ?? null) : null,
          fingerprint({ account: text(t.account, 60), date: t.date, payee: text(t.payee, 200), description: text(t.description, 500), amountCents: t.amountCents, externalId: t.externalId })],
      ).catch((err: unknown) => { throw archivedConflict(err); });
      added += res.rowCount ?? 0;
    }
    return { added, duplicates: items.length - added };
  }

  async listTransactions(filter: TransactionFilter = {}): Promise<BudgetTransaction[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.month) {
      const { start, end } = monthBounds(filter.month);
      args.push(start, end); where.push(`txn_date >= $${args.length - 1} AND txn_date < $${args.length}`);
    }
    if (filter.categoryId) { args.push(filter.categoryId); where.push(`category_id = $${args.length}`); }
    if (filter.account) { args.push(filter.account); where.push(`account = $${args.length}`); }
    if (filter.needsReview) where.push(`(source IS NULL OR source = 'agent_guess')`);
    args.push(Math.min(Math.max(filter.limit ?? 200, 1), 500));
    const { rows } = await this.pool.query<TxnRow>(
      `SELECT ${TXN_COLUMNS} FROM budget_transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY txn_date DESC, created_at DESC LIMIT $${args.length}`,
      args,
    );
    return rows.map(toTxn);
  }

  /** The owner sets (or clears, with null) the category: that is always source "you". */
  async categorise(ids: string[], categoryId: string | null): Promise<number> {
    if (ids.length === 0 || ids.length > 500) throw new BudgetError('Choose between 1 and 500 transactions');
    if (categoryId !== null) {
      const ok = await this.pool.query(`SELECT 1 FROM budget_categories WHERE id = $1 AND archived_at IS NULL`, [categoryId]);
      if (ok.rowCount === 0) throw new BudgetError('No such category', 'not_found');
    }
    const res = await this.pool.query(
      `UPDATE budget_transactions SET category_id = $2::uuid, source = CASE WHEN $2::uuid IS NULL THEN NULL ELSE 'you' END,
         rule_id = NULL, confidence = NULL WHERE id = ANY($1::uuid[])`,
      [ids, categoryId],
    ).catch((err: unknown) => { throw archivedConflict(err); });
    if (res.rowCount === 0) throw new BudgetError('No such transaction', 'not_found');
    return res.rowCount ?? 0;
  }

  // -- the summary every screen reads ----------------------------------------------------------------------------

  async summary(month: string): Promise<BudgetSummary> {
    const { start, end } = monthBounds(month);
    // Spending only: income and savings categories are planned by month but are not budgets that can be overspent.
    // An archived category appears only in months where it has transactions, and keeps its budget only for months that
    // were over before it was archived.
    const { rows } = await this.pool.query<{ id: string; name: string; archived: boolean; monthly_cents: number | null; spent: string }>(
      `SELECT c.id, c.name, c.archived_at IS NOT NULL AS archived,
              CASE WHEN c.archived_at IS NULL OR c.archived_at >= $2::date THEN COALESCE(m.cents, c.monthly_cents) END AS monthly_cents,
              COALESCE(-SUM(t.amount_cents) FILTER (WHERE t.amount_cents < 0), 0)::text AS spent
       FROM budget_categories c
       LEFT JOIN budget_month_amounts m ON m.category_id = c.id AND m.month = $3
       LEFT JOIN budget_transactions t ON t.category_id = c.id AND t.txn_date >= $1 AND t.txn_date < $2
       WHERE c.kind = 'expense'
       GROUP BY c.id, m.cents HAVING c.archived_at IS NULL OR count(t.id) > 0
       ORDER BY (c.archived_at IS NOT NULL), c.sort_order, lower(c.name)`,
      [start, end, month],
    );
    const loose = await this.pool.query<{ uncategorised: string; spent: string; guesses: string }>(
      `SELECT count(*) FILTER (WHERE source IS NULL)::text AS uncategorised,
              COALESCE(-SUM(amount_cents) FILTER (WHERE source IS NULL AND amount_cents < 0), 0)::text AS spent,
              count(*) FILTER (WHERE source = 'agent_guess')::text AS guesses
       FROM budget_transactions WHERE txn_date >= $1 AND txn_date < $2`,
      [start, end],
    );
    const categories: CategorySummary[] = rows.map(r => {
      const spentCents = Number(r.spent);
      return {
        categoryId: r.id, name: r.name, archived: r.archived, budgetedCents: r.monthly_cents, spentCents,
        remainingCents: r.monthly_cents === null ? null : r.monthly_cents - spentCents,
        state: stateFor(r.monthly_cents, spentCents),
      };
    });
    const l = loose.rows[0]!;
    return {
      month,
      categories,
      totals: {
        budgetedCents: categories.reduce((n, c) => n + (c.budgetedCents ?? 0), 0),
        spentCents: categories.reduce((n, c) => n + c.spentCents, 0) + Number(l.spent),
        uncategorisedSpentCents: Number(l.spent),
      },
      needsYou: { uncategorised: Number(l.uncategorised), guesses: Number(l.guesses), overBudget: categories.filter(c => c.state === 'over' && !c.archived).length },
    };
  }

  // -- money in and out over time ---------------------------------------------------------------------------------

  /** Every stored transaction counts, whatever its category: money moved between the owner's accounts is included. */
  async trend(asOf: string): Promise<BudgetTrend> {
    const at = new Date(`${asOf}T00:00:00Z`);
    if (!DAY.test(asOf) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== asOf) throw new BudgetError('asOf must be a YYYY-MM-DD date');
    const [y, m0, d] = [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()];
    const first = (await this.pool.query<{ day: string | null }>(`SELECT to_char(min(txn_date), 'YYYY-MM-DD') AS day FROM budget_transactions`)).rows[0]!.day;
    const { rows } = await this.pool.query<{ month: string; out: string; inn: string }>(
      `SELECT to_char(txn_date, 'YYYY-MM') AS month,
              COALESCE(-SUM(amount_cents) FILTER (WHERE amount_cents < 0), 0)::text AS out,
              COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents > 0), 0)::text AS inn
       FROM budget_transactions WHERE txn_date >= $1 AND txn_date <= $2 GROUP BY 1`,
      [isoDay(y, m0 - 23, 1), asOf],
    );
    const byMonth = new Map(rows.map(r => [r.month, r]));
    const months: BudgetTrend['months'] = [];
    for (let back = 23; back >= 0; back--) {
      const month = isoDay(y, m0 - back, 1).slice(0, 7);
      if (!first || month < first.slice(0, 7)) continue;
      months.push({ month, outCents: Number(byMonth.get(month)?.out ?? 0), inCents: Number(byMonth.get(month)?.inn ?? 0) });
    }
    const spent = async (from: string, to: string): Promise<number> => Number((await this.pool.query<{ out: string }>(
      `SELECT COALESCE(-SUM(amount_cents) FILTER (WHERE amount_cents < 0), 0)::text AS out FROM budget_transactions WHERE txn_date >= $1 AND txn_date <= $2`,
      [from, to])).rows[0]!.out);
    const compare = async (current: [string, string], previous: [string, string]): Promise<PeriodCompare> => ({
      currentCents: await spent(...current),
      previousCents: first !== null && first <= previous[0] ? await spent(...previous) : null,
    });
    return {
      asOf, firstDate: first, months,
      monthToDate: await compare([isoDay(y, m0, 1), asOf], [isoDay(y, m0 - 1, 1), clampedDay(y, m0 - 1, d)]),
      lastMonth: await compare([isoDay(y, m0 - 1, 1), isoDay(y, m0, 0)], [isoDay(y, m0 - 2, 1), isoDay(y, m0 - 1, 0)]),
      yearToDate: await compare([isoDay(y, 0, 1), asOf], [isoDay(y - 1, 0, 1), clampedDay(y - 1, m0, d)]),
    };
  }

  // -- rules (one YAML document) ---------------------------------------------------------------------------------

  async getRules(): Promise<{ yaml: string; updatedAt: string | null }> {
    const { rows } = await this.pool.query<{ yaml: string; updated_at: Date }>(`SELECT yaml, updated_at FROM budget_rules WHERE id = 1`);
    return rows[0] ? { yaml: rows[0].yaml, updatedAt: rows[0].updated_at.toISOString() } : { yaml: '', updatedAt: null };
  }

  async putRules(source: unknown): Promise<{ updatedAt: string }> {
    if (typeof source !== 'string') throw new BudgetError('yaml must be text');
    if (Buffer.byteLength(source) > MAX_RULES_BYTES) throw new BudgetError('The rules are larger than 64 KB');
    try {
      yaml.load(source);
    } catch (err) {
      // Only the parser's own short reason is shown; nothing from the file is logged.
      throw new BudgetError(`The rules are not valid YAML: ${(err as { reason?: string }).reason ?? 'syntax error'}`);
    }
    const { rows } = await this.pool.query<{ updated_at: Date }>(
      `INSERT INTO budget_rules (id, yaml) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET yaml = EXCLUDED.yaml, updated_at = now() RETURNING updated_at`,
      [source],
    );
    return { updatedAt: rows[0]!.updated_at.toISOString() };
  }
}
