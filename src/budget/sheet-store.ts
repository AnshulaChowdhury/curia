// sheet-store.ts — the spreadsheets the owner is working on for the budget. Owner-only data.

import type { DbPool } from '../db/connection.js';
import { BudgetError } from './budget-store.js';
import { sanitizeWorkbook, type Workbook } from './sheet-snapshot.js';

export interface SheetInfo { id: string; name: string; version: number; updatedAt: string; expiresAt: string }
export interface Sheet extends SheetInfo { workbook: Workbook }

/** How many sheets may be held at once; the owner deletes one to add another. */
export const MAX_STORED_SHEETS = 20;

interface Row { id: string; name: string; version: number; updated_at: Date; expires_at: Date; snapshot?: Workbook }
const info = (r: Row): SheetInfo => ({ id: r.id, name: r.name, version: r.version, updatedAt: r.updated_at.toISOString(), expiresAt: r.expires_at.toISOString() });
const COLUMNS = 'id, name, version, updated_at, expires_at';
const title = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 120) : '');

export class SheetStore {
  constructor(private readonly pool: DbPool) {}

  /** The sheets that have not expired, newest first. Expired ones are removed here. */
  async list(): Promise<SheetInfo[]> {
    await this.pool.query('DELETE FROM budget_sheets WHERE expires_at <= now()');
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM budget_sheets ORDER BY updated_at DESC`);
    return rows.map(info);
  }

  async create(input: { name?: unknown; workbook?: unknown }): Promise<Sheet> {
    const workbook = sanitizeWorkbook(input.workbook);
    const name = title(input.name) || 'Budget';
    if ((await this.list()).length >= MAX_STORED_SHEETS) throw new BudgetError(`There are already ${MAX_STORED_SHEETS} sheets. Delete one first.`, 'conflict');
    const { rows } = await this.pool.query<Row>(`INSERT INTO budget_sheets (name, snapshot) VALUES ($1, $2) RETURNING ${COLUMNS}`, [name, JSON.stringify(workbook)]);
    return { ...info(rows[0]!), workbook };
  }

  async get(id: string): Promise<Sheet> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS}, snapshot FROM budget_sheets WHERE id = $1 AND expires_at > now()`, [id]);
    if (!rows[0]) throw new BudgetError('No such sheet', 'not_found');
    return { ...info(rows[0]), workbook: rows[0].snapshot! };
  }

  /** Saves over the version the caller read. A different current version is a conflict, never an overwrite. */
  async save(id: string, version: unknown, rawWorkbook: unknown): Promise<SheetInfo> {
    if (typeof version !== 'number' || !Number.isInteger(version)) throw new BudgetError('version must be the number you loaded');
    const workbook = sanitizeWorkbook(rawWorkbook);
    const { rows } = await this.pool.query<Row>(
      `UPDATE budget_sheets SET snapshot = $3, version = version + 1, updated_at = now(), expires_at = now() + interval '14 days'
       WHERE id = $1 AND version = $2 AND expires_at > now() RETURNING ${COLUMNS}`,
      [id, version, JSON.stringify(workbook)]);
    if (rows[0]) return info(rows[0]);
    await this.get(id); // not_found if it is gone
    throw new BudgetError('This sheet changed somewhere else. Reload it before editing.', 'conflict');
  }

  async remove(id: string): Promise<void> {
    const res = await this.pool.query('DELETE FROM budget_sheets WHERE id = $1', [id]);
    if (res.rowCount === 0) throw new BudgetError('No such sheet', 'not_found');
  }
}
