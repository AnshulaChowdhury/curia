// proposal-store.ts — budget changes proposed in a chat and applied only when the owner approves them (ADR-067).
//
// The assistant can do one thing here: write a proposal. Applying one is called only by the owner's signed-in console,
// so no agent can change the budget. A proposal records how each category stood when it was made; if any of them has
// changed since, nothing is applied.

import type { DbPool } from '../db/connection.js';
import { BudgetError, CATEGORY_KINDS, type CategoryKind } from './budget-store.js';

export const MAX_PROPOSED_CATEGORIES = 100;
export const MAX_PROPOSED_MONTHS = 24;
const MAX_CENTS = 2_000_000_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface ProposedRow {
  action: 'create' | 'update' | 'archive';
  name: string;
  /** The category as it is called now, when the change renames it. */
  renameFrom?: string;
  kind: CategoryKind;
  categoryId: string | null;
  previousKind?: CategoryKind;
  /** `was` is what the month had when the proposal was made. */
  amounts: Array<{ month: string; cents: number; was: number | null }>;
}

export interface Proposal { id: string; rows: ProposedRow[]; createdAt: string; expiresAt: string }

interface Wanted { name: string; renameFrom?: string; kind?: CategoryKind; archive: boolean; amounts: Array<{ month: string; cents: number }> }
interface CurrentRow { id: string; name: string; kind: CategoryKind; monthly_cents: number | null }
type Queryable = Pick<DbPool, 'query'>;

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim() : '');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The changes asked for, checked. Months are named once and each category lists its dollars in the same order (null: no
 * amount that month): compact, so a whole budget fits in one reply from the model.
 */
function parse(input: unknown, monthList: unknown): Wanted[] {
  const listed = monthList === undefined ? [] : monthList;
  if (!Array.isArray(listed) || listed.length > MAX_PROPOSED_MONTHS || !listed.every((m): m is string => typeof m === 'string' && MONTH.test(m)) || new Set(listed).size !== listed.length) {
    throw new BudgetError(`months must be up to ${MAX_PROPOSED_MONTHS} different months, each YYYY-MM`);
  }
  if (!Array.isArray(input) || input.length === 0) throw new BudgetError('Give at least one category');
  if (input.length > MAX_PROPOSED_CATEGORIES) throw new BudgetError(`Propose at most ${MAX_PROPOSED_CATEGORIES} categories at a time`);
  const taken = new Set<string>();
  return input.map((raw: unknown) => {
    if (!isObj(raw)) throw new BudgetError('Each category must be an object');
    const name = clean(raw['name']);
    if (!name || name.length > 60) throw new BudgetError('Each category needs a name of 1 to 60 characters');
    const renameFrom = clean(raw['renameFrom']) || undefined;
    for (const used of new Set([name.toLowerCase(), (renameFrom ?? name).toLowerCase()])) {
      if (taken.has(used)) throw new BudgetError(`"${name}" appears twice. Give each category once.`);
      taken.add(used);
    }
    const kind = raw['type'] === undefined ? undefined : raw['type'] as CategoryKind;
    if (kind !== undefined && !CATEGORY_KINDS.includes(kind)) throw new BudgetError(`"${name}": type must be expense, income or savings`);
    const given = raw['amounts'] === undefined ? [] : raw['amounts'];
    if (!Array.isArray(given) || (given.length > 0 && given.length !== listed.length)) {
      throw new BudgetError(`"${name}": amounts must list one entry for each of the ${listed.length} months, null for none`);
    }
    const amounts = given.flatMap((dollars: unknown, i) => {
      if (dollars === null) return [];
      const cents = typeof dollars === 'number' ? Math.round(dollars * 100) : NaN;
      if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) throw new BudgetError(`"${name}": each amount must be a number of dollars, zero or more, or null`);
      return [{ month: listed[i]!, cents }];
    }).sort((a, b) => a.month.localeCompare(b.month));
    return { name, renameFrom, kind, archive: raw['archive'] === true, amounts };
  });
}

async function openCategories(db: Queryable, lock = false): Promise<Map<string, CurrentRow>> {
  const { rows } = await db.query<CurrentRow>(
    `SELECT id, name, kind, monthly_cents FROM budget_categories WHERE archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`);
  return new Map(rows.map(r => [r.name.toLowerCase(), r]));
}

/** What each of these months holds for a category now: its own amount, else the usual one. */
async function amountsNow(db: Queryable, category: CurrentRow, months: string[]): Promise<Map<string, number | null>> {
  const { rows } = await db.query<{ month: string; cents: number }>(
    'SELECT month, cents FROM budget_month_amounts WHERE category_id = $1 AND month = ANY($2::text[])', [category.id, months]);
  const own = new Map(rows.map(r => [r.month, r.cents]));
  return new Map(months.map(m => [m, own.get(m) ?? category.monthly_cents]));
}

export class ProposalStore {
  constructor(private readonly pool: DbPool) {}

  /** Records the changes for the owner to look at, replacing any still waiting in this chat. Changes no budget. */
  async propose(conversationId: string, categories: unknown, months?: unknown): Promise<Proposal> {
    const wanted = parse(categories, months);
    const current = await openCategories(this.pool);
    const rows: ProposedRow[] = [];
    for (const w of wanted) {
      const found = current.get((w.renameFrom ?? w.name).toLowerCase());
      if (w.renameFrom && !found) throw new BudgetError(`There is no category called "${w.renameFrom}" to rename`);
      if (w.renameFrom && current.has(w.name.toLowerCase()) && current.get(w.name.toLowerCase()) !== found) throw new BudgetError(`A category called "${w.name}" already exists`);
      if (w.archive) {
        if (!found) throw new BudgetError(`There is no category called "${w.name}" to archive`);
        rows.push({ action: 'archive', name: found.name, kind: found.kind, previousKind: found.kind, categoryId: found.id, amounts: [] });
        continue;
      }
      if (!found) {
        rows.push({ action: 'create', name: w.name, kind: w.kind ?? 'expense', categoryId: null, amounts: w.amounts.map(a => ({ ...a, was: null })) });
        continue;
      }
      const was = await amountsNow(this.pool, found, w.amounts.map(a => a.month));
      const amounts = w.amounts.map(a => ({ ...a, was: was.get(a.month) ?? null })).filter(a => a.cents !== a.was);
      const kind = w.kind ?? found.kind;
      // The same as it is now: nothing to approve.
      if (amounts.length === 0 && kind === found.kind && w.name === found.name) continue;
      rows.push({ action: 'update', name: w.name, ...(w.name !== found.name ? { renameFrom: found.name } : {}), kind, previousKind: found.kind, categoryId: found.id, amounts });
    }
    if (rows.length === 0) throw new BudgetError('The budget already matches: there is nothing to change');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE budget_proposals SET status = 'replaced', decided_at = now() WHERE conversation_id = $1 AND status = 'pending'`, [conversationId]);
      const made = await client.query<{ id: string; created_at: Date; expires_at: Date }>(
        'INSERT INTO budget_proposals (conversation_id, changes) VALUES ($1, $2) RETURNING id, created_at, expires_at', [conversationId, JSON.stringify(rows)]);
      await client.query('COMMIT');
      const r = made.rows[0]!;
      return { id: r.id, rows, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The proposal waiting in this chat, if any. */
  async pending(conversationId: string): Promise<Proposal | null> {
    const { rows } = await this.pool.query<{ id: string; changes: ProposedRow[]; created_at: Date; expires_at: Date }>(
      `SELECT id, changes, created_at, expires_at FROM budget_proposals WHERE conversation_id = $1 AND status = 'pending' AND expires_at > now()`,
      [conversationId]);
    const r = rows[0];
    return r ? { id: r.id, rows: r.changes, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() } : null;
  }

  async discard(id: string, conversationId: string): Promise<void> {
    const done = await this.pool.query(
      `UPDATE budget_proposals SET status = 'discarded', decided_at = now() WHERE id = $1 AND conversation_id = $2 AND status = 'pending'`, [id, conversationId]);
    if (!done.rowCount) throw new BudgetError('That proposal is no longer waiting', 'conflict');
  }

  /** The owner's approval: every change in one transaction, or none. */
  async apply(id: string, conversationId: string): Promise<{ created: number; updated: number; archived: number }> {
    const stale = (name: string) => new BudgetError(`"${name}" has changed since this was proposed, so nothing was applied. Ask for a new proposal.`, 'conflict');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ changes: ProposedRow[] }>(
        `SELECT changes FROM budget_proposals WHERE id = $1 AND conversation_id = $2 AND status = 'pending' AND expires_at > now() FOR UPDATE`, [id, conversationId]);
      const rows = found.rows[0]?.changes;
      if (!rows) throw new BudgetError('That proposal is no longer waiting', 'conflict');
      const current = await openCategories(client, true);
      const done = { created: 0, updated: 0, archived: 0 };
      for (const row of rows) {
        let categoryId = row.categoryId;
        if (row.action === 'create') {
          if (current.has(row.name.toLowerCase())) throw stale(row.name);
          const made = await client.query<{ id: string }>(
            `INSERT INTO budget_categories (name, kind, sort_order) VALUES ($1, $2, COALESCE((SELECT max(sort_order) + 1 FROM budget_categories), 0)) RETURNING id`,
            [row.name, row.kind]);
          categoryId = made.rows[0]!.id;
          done.created += 1;
        } else {
          const now = current.get((row.renameFrom ?? row.name).toLowerCase());
          if (!now || now.id !== row.categoryId || now.kind !== row.previousKind) throw stale(row.renameFrom ?? row.name);
          const amounts = await amountsNow(client, now, row.amounts.map(a => a.month));
          if (row.amounts.some(a => (amounts.get(a.month) ?? null) !== a.was)) throw stale(now.name);
          if (row.action === 'archive') {
            await client.query('UPDATE budget_categories SET archived_at = now(), updated_at = now() WHERE id = $1', [now.id]);
            done.archived += 1;
            continue;
          }
          await client.query('UPDATE budget_categories SET name = $2, kind = $3, updated_at = now() WHERE id = $1', [now.id, row.name, row.kind]);
          done.updated += 1;
        }
        for (const a of row.amounts) {
          await client.query(
            `INSERT INTO budget_month_amounts (category_id, month, cents) VALUES ($1, $2, $3)
             ON CONFLICT (category_id, month) DO UPDATE SET cents = EXCLUDED.cents`, [categoryId, a.month, a.cents]);
        }
      }
      await client.query(`UPDATE budget_proposals SET status = 'applied', decided_at = now() WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return done;
    } catch (err) {
      await client.query('ROLLBACK');
      // A name taken between the check and the write.
      if ((err as { code?: string }).code === '23505') throw new BudgetError('A category with that name already exists, so nothing was applied. Ask for a new proposal.', 'conflict');
      throw err;
    } finally {
      client.release();
    }
  }
}
