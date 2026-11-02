// batch-store.ts — weekly books batches: stored as pushed by the books agent, reviewed and approved by the owner,
// pulled back by the agent for posting, with the posting results recorded per row.
//
// Rows come from bank files and are untrusted JSON: they are stored as-is, returned as JSON, and only ever rendered
// as text. A person's edits are kept apart from the pushed data and merged on read, so pushing the same batch again
// can never overwrite an edit, a decision or a result.

import type { DbPool } from '../db/connection.js';

export const EDITABLE_FIELDS = ['category', 'tax_code', 'location', 'class', 'payee'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type Decision = 'pending' | 'approved' | 'skipped';
export type ResultStatus = 'posted' | 'manual' | 'failed' | 'skipped';

/** Flags that stop a row being approved until a category is chosen. */
export const BLOCKING_FLAG_KINDS = ['needs_category', 'row_error', 'unpaired_transfer', 'amount_differs', 'date_differs'] as const;

export const MAX_ROWS = 2000;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_FIELD_LENGTH = 200;

export type PushedRow = { id: string; amount: string; date: string; description: string } & Record<string, unknown>;

export interface RowResult {
  status: ResultStatus;
  qbo_id?: string;
  entity?: string;
  message?: string;
}

export interface BatchRow {
  id: string;
  /** The row as pushed with the person's edits merged over it. */
  row: Record<string, unknown>;
  edits: Partial<Record<EditableField, string>>;
  decision: Decision;
  result: RowResult | null;
}

export interface BatchSummary {
  batch_id: string;
  created_at: string;
  status: string;
  rows: number;
  pending: number;
  approved: number;
  skipped: number;
  posted: number;
  failed: number;
  manual: number;
  report: Record<string, unknown>;
}

/** The person (or caller) did something not allowed: bad edit, approving a row with an open flag, a missing batch. */
export class BatchError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'not_found' | 'locked' = 'invalid') {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Checks a pushed batch; returns the rows or throws BatchError. Everything beyond the required keys is kept as-is. */
export function validatePush(batchId: unknown, rows: unknown, report: unknown): { batchId: string; rows: PushedRow[]; report: Record<string, unknown> } {
  if (typeof batchId !== 'string' || !/^[0-9a-f]{8,64}$/.test(batchId)) throw new BatchError('batch_id must be 8 to 64 hex characters');
  if (!Array.isArray(rows)) throw new BatchError('rows must be an array');
  if (rows.length > MAX_ROWS) throw new BatchError(`A batch can have at most ${MAX_ROWS} rows`);
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    if (!isObject(r)) throw new BatchError(`Row ${i + 1} is not an object`);
    if (typeof r.id !== 'string' || !r.id || r.id.length > 100) throw new BatchError(`Row ${i + 1} needs a string id of at most 100 characters`);
    for (const k of ['amount', 'date', 'description'] as const) {
      if (typeof r[k] !== 'string') throw new BatchError(`Row ${r.id} needs a string ${k}`);
    }
    if (seen.has(r.id)) throw new BatchError(`Row id ${r.id} appears twice`);
    seen.add(r.id);
  }
  const rep = report === undefined || report === null ? {} : report;
  if (!isObject(rep)) throw new BatchError('report must be an object');
  if (Buffer.byteLength(JSON.stringify({ rows, report: rep })) > MAX_BATCH_BYTES) throw new BatchError('The batch is larger than 2 MB');
  return { batchId, rows: rows as PushedRow[], report: rep };
}

/** Checks a set of edits: only the editable fields, short strings; null or empty removes an edit. */
export function validateEdits(edits: unknown): Record<string, string | null> {
  if (!isObject(edits)) throw new BatchError('edits must be an object');
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(edits)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(k)) throw new BatchError(`${k} cannot be edited`);
    if (v === null || v === '') {
      out[k] = null;
    } else if (typeof v === 'string' && v.length <= MAX_FIELD_LENGTH) {
      out[k] = v.trim() || null;
    } else {
      throw new BatchError(`${k} must be text of at most ${MAX_FIELD_LENGTH} characters`);
    }
  }
  return out;
}

/** Merges a stored edits object with changes (null removes). */
export function applyEdits(current: Record<string, unknown>, changes: Record<string, string | null>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) if (typeof v === 'string' && v) next[k] = v;
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

function flagKinds(data: Record<string, unknown>): string[] {
  const flags = data.flags;
  if (!Array.isArray(flags)) return [];
  return flags.map(f => (isObject(f) && typeof f.kind === 'string' ? f.kind : '')).filter(Boolean);
}

/** Why a row cannot be approved yet, or null: it has an open flag and still no category after the person's edits. */
export function approvalBlocker(row: Record<string, unknown>): string | null {
  const blocking = flagKinds(row).filter(k => (BLOCKING_FLAG_KINDS as readonly string[]).includes(k));
  if (blocking.length === 0) return null;
  const category = typeof row.category === 'string' ? row.category.trim() : '';
  if (category) return null;
  return `Row ${String(row.id)} has an unresolved flag (${blocking.join(', ')}) and no category: choose a category first`;
}

interface RowRecord {
  batch_id?: string;
  row_id: string;
  data: Record<string, unknown>;
  edits: Record<string, unknown>;
  decision: Decision;
  result: RowResult | null;
}

const toBatchRow = (r: RowRecord): BatchRow => ({
  id: r.row_id,
  row: { ...r.data, ...r.edits, id: r.row_id },
  edits: r.edits as Partial<Record<EditableField, string>>,
  decision: r.decision,
  result: r.result,
});

const isPosted = (r: { result: RowResult | null }): boolean => r.result?.status === 'posted';

export class BatchStore {
  constructor(private readonly pool: DbPool) {}

  /**
   * Stores a pushed batch. Pushing the same batch id again updates the report, adds new rows, and refreshes a row's
   * pushed data only while that row is still pending and not posted; edits, decisions and results are never touched.
   */
  async upsertBatch(batchId: string, report: Record<string, unknown>, rows: PushedRow[]): Promise<number> {
    await this.pool.query(
      `INSERT INTO books_batches (batch_id, report) VALUES ($1, $2::jsonb)
       ON CONFLICT (batch_id) DO UPDATE SET report = EXCLUDED.report`,
      [batchId, JSON.stringify(report)],
    );
    if (rows.length > 0) {
      await this.pool.query(
        `INSERT INTO books_batch_rows (batch_id, row_id, data)
         SELECT $1::text, r->>'id', r FROM jsonb_array_elements($2::jsonb) AS r
         ON CONFLICT (batch_id, row_id) DO UPDATE SET data = EXCLUDED.data
           WHERE books_batch_rows.decision = 'pending'
             AND COALESCE(books_batch_rows.result->>'status', '') <> 'posted'
             AND books_batch_rows.data IS DISTINCT FROM EXCLUDED.data`,
        [batchId, JSON.stringify(rows)],
      );
    }
    return rows.length;
  }

  async listBatches(): Promise<BatchSummary[]> {
    const { rows } = await this.pool.query<{
      batch_id: string; created_at: Date; status: string; report: Record<string, unknown>;
      total: string; pending: string; approved: string; skipped: string; posted: string; failed: string; manual: string;
    }>(
      `SELECT b.batch_id, b.created_at, b.status, b.report,
              count(r.row_id) AS total,
              count(*) FILTER (WHERE r.decision = 'pending') AS pending,
              count(*) FILTER (WHERE r.decision = 'approved') AS approved,
              count(*) FILTER (WHERE r.decision = 'skipped') AS skipped,
              count(*) FILTER (WHERE r.result->>'status' = 'posted') AS posted,
              count(*) FILTER (WHERE r.result->>'status' = 'failed') AS failed,
              count(*) FILTER (WHERE r.result->>'status' = 'manual') AS manual
         FROM books_batches b LEFT JOIN books_batch_rows r USING (batch_id)
        GROUP BY b.batch_id ORDER BY b.created_at DESC LIMIT 100`,
    );
    return rows.map(r => ({
      batch_id: r.batch_id, created_at: r.created_at.toISOString(), status: r.status, report: r.report,
      rows: Number(r.total), pending: Number(r.pending), approved: Number(r.approved), skipped: Number(r.skipped),
      posted: Number(r.posted), failed: Number(r.failed), manual: Number(r.manual),
    }));
  }

  async getBatch(batchId: string): Promise<{ batch_id: string; created_at: string; status: string; report: Record<string, unknown>; rows: BatchRow[] }> {
    const b = await this.pool.query<{ batch_id: string; created_at: Date; status: string; report: Record<string, unknown> }>(
      'SELECT batch_id, created_at, status, report FROM books_batches WHERE batch_id = $1',
      [batchId],
    );
    const batch = b.rows[0];
    if (!batch) throw new BatchError('No such batch', 'not_found');
    const r = await this.pool.query<RowRecord>(
      `SELECT row_id, data, edits, decision, result FROM books_batch_rows
        WHERE batch_id = $1 ORDER BY data->>'date', data->>'account', row_id`,
      [batchId],
    );
    return { batch_id: batch.batch_id, created_at: batch.created_at.toISOString(), status: batch.status, report: batch.report, rows: r.rows.map(toBatchRow) };
  }

  private async loadRow(batchId: string, rowId: string): Promise<RowRecord> {
    const { rows } = await this.pool.query<RowRecord>(
      'SELECT row_id, data, edits, decision, result FROM books_batch_rows WHERE batch_id = $1 AND row_id = $2',
      [batchId, rowId],
    );
    const row = rows[0];
    if (!row) throw new BatchError('No such row', 'not_found');
    return row;
  }

  /** Changes the editable fields of a pending row. Returns the row as it now reads. */
  async editRow(batchId: string, rowId: string, rawEdits: unknown): Promise<BatchRow> {
    const changes = validateEdits(rawEdits);
    const row = await this.loadRow(batchId, rowId);
    if (isPosted(row)) throw new BatchError('That row is already posted to QuickBooks', 'locked');
    if (row.decision !== 'pending') throw new BatchError('Undo the approval or skip before editing that row', 'locked');
    const next = applyEdits(row.edits, changes);
    const upd = await this.pool.query<RowRecord>(
      `UPDATE books_batch_rows SET edits = $3::jsonb
        WHERE batch_id = $1 AND row_id = $2 AND decision = 'pending' AND COALESCE(result->>'status', '') <> 'posted'
        RETURNING row_id, data, edits, decision, result`,
      [batchId, rowId, JSON.stringify(next)],
    );
    if (!upd.rows[0]) throw new BatchError('That row changed while you were editing it: reload and try again', 'locked');
    return toBatchRow(upd.rows[0]);
  }

  /**
   * Approves, skips or un-decides rows. Posted rows are final. Approving needs every row to be free of open flags
   * (or to have a category); if any row cannot be approved nothing is changed.
   */
  async decide(batchId: string, rowIds: string[], decision: Decision): Promise<number> {
    if (!['approved', 'skipped', 'pending'].includes(decision)) throw new BatchError('decision must be approved, skipped or pending');
    if (rowIds.length === 0 || rowIds.length > MAX_ROWS) throw new BatchError('Choose at least one row');
    const { rows } = await this.pool.query<RowRecord>(
      'SELECT row_id, data, edits, decision, result FROM books_batch_rows WHERE batch_id = $1 AND row_id = ANY($2::text[])',
      [batchId, rowIds],
    );
    if (rows.length !== new Set(rowIds).size) throw new BatchError('One of those rows is not in this batch', 'not_found');
    for (const r of rows) {
      if (isPosted(r)) throw new BatchError(`Row ${r.row_id} is already posted to QuickBooks`, 'locked');
      if (decision === 'approved') {
        const blocker = approvalBlocker({ ...r.data, ...r.edits, id: r.row_id });
        if (blocker) throw new BatchError(blocker);
      }
    }
    // Approving again clears an earlier failed or manual result, so the agent picks the row up afresh.
    const upd = await this.pool.query(
      `UPDATE books_batch_rows
          SET decision = $3::text, decided_at = CASE WHEN $3::text = 'pending' THEN NULL ELSE now() END,
              result = CASE WHEN $3::text = 'approved' THEN NULL ELSE result END
        WHERE batch_id = $1 AND row_id = ANY($2::text[]) AND COALESCE(result->>'status', '') <> 'posted'`,
      [batchId, rowIds, decision],
    );
    return upd.rowCount ?? 0;
  }

  /** Approved rows the agent has not yet reported on, grouped by batch, each with the person's edits merged in. */
  async approvedForPosting(): Promise<Array<{ batch_id: string; rows: Array<Record<string, unknown>> }>> {
    const { rows } = await this.pool.query<RowRecord & { batch_id: string }>(
      `SELECT batch_id, row_id, data, edits, decision, result FROM books_batch_rows
        WHERE decision = 'approved' AND result IS NULL
        ORDER BY batch_id, data->>'date', data->>'account', row_id`,
    );
    const byBatch = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows) {
      const list = byBatch.get(r.batch_id) ?? [];
      list.push(toBatchRow(r).row);
      byBatch.set(r.batch_id, list);
    }
    return [...byBatch].map(([batch_id, list]) => ({ batch_id, rows: list }));
  }

  /**
   * Records what the agent did with each row. 'posted' is final and locks the row. 'failed' and 'manual' send the row
   * back to pending so a person sees it. 'skipped' (the agent left it alone, e.g. already in QuickBooks) closes it.
   */
  async recordResults(batchId: string, results: unknown): Promise<{ recorded: number; ignored: string[] }> {
    if (!isObject(results)) throw new BatchError('results must be an object');
    const entries = Object.entries(results);
    if (entries.length > MAX_ROWS) throw new BatchError(`At most ${MAX_ROWS} results at once`);
    const clean: Array<[string, RowResult]> = [];
    for (const [rowId, v] of entries) {
      if (!isObject(v) || !['posted', 'manual', 'failed', 'skipped'].includes(String(v.status))) {
        throw new BatchError(`Result for ${rowId} needs a status of posted, manual, failed or skipped`);
      }
      const res: RowResult = { status: v.status as ResultStatus };
      for (const k of ['qbo_id', 'entity', 'message'] as const) {
        const val = v[k];
        if (val !== undefined && val !== null) {
          if (typeof val !== 'string') throw new BatchError(`${k} for ${rowId} must be text`);
          res[k] = val.slice(0, 500);
        }
      }
      clean.push([rowId, res]);
    }
    const exists = await this.pool.query('SELECT 1 FROM books_batches WHERE batch_id = $1', [batchId]);
    if (exists.rowCount === 0) throw new BatchError('No such batch', 'not_found');
    let recorded = 0;
    const ignored: string[] = [];
    for (const [rowId, res] of clean) {
      const upd = await this.pool.query(
        `UPDATE books_batch_rows
            SET result = $3::jsonb,
                decision = CASE WHEN $4::text IN ('failed', 'manual') THEN 'pending'
                                WHEN $4::text = 'skipped' THEN 'skipped' ELSE decision END
          WHERE batch_id = $1 AND row_id = $2 AND decision = 'approved' AND result IS NULL`,
        [batchId, rowId, JSON.stringify(res), res.status],
      );
      if ((upd.rowCount ?? 0) > 0) recorded += 1;
      else ignored.push(rowId);                       // not approved, already reported, or unknown: left alone
    }
    return { recorded, ignored };
  }
}
