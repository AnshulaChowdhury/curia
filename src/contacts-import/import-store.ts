// import-store.ts — what the contacts import remembers between a dry run and an apply: the reviewed plan, which
// outside record became which contact, and each contact's work / personal label.
//
// Two implementations behind one interface: Postgres (migration 112) and an in-memory one for tests.

import type { Pool } from 'pg';

export type ImportLabel = 'work' | 'personal' | 'hybrid';

export interface StoredBatch {
  batchId: string;
  inputHash: string;
  plan: unknown;
  status: 'planned' | 'applied';
  result: unknown;
}

export interface ImportStore {
  /** Saves (or, for a batch not yet applied, replaces) the plan. An applied batch is never replaced. */
  savePlan(batchId: string, inputHash: string, plan: unknown): Promise<boolean>;
  getBatch(batchId: string): Promise<StoredBatch | null>;
  /** Marks the batch applied. False if it already was: the first apply wins. */
  markApplied(batchId: string, result: unknown): Promise<boolean>;
  getContactIdForSource(sourceKey: string): Promise<string | null>;
  recordSource(sourceKey: string, contactId: string, batchId: string): Promise<void>;
  /** Stores a suggestion. Never touches a decision a person already made. */
  suggestLabel(contactId: string, label: ImportLabel): Promise<void>;
  getLabel(contactId: string): Promise<{ suggested: ImportLabel | null; label: ImportLabel | null } | null>;
}

export class InMemoryImportStore implements ImportStore {
  private batches = new Map<string, StoredBatch>();
  private sources = new Map<string, string>();
  private labels = new Map<string, { suggested: ImportLabel | null; label: ImportLabel | null }>();

  async savePlan(batchId: string, inputHash: string, plan: unknown): Promise<boolean> {
    const existing = this.batches.get(batchId);
    if (existing?.status === 'applied') return false;
    this.batches.set(batchId, { batchId, inputHash, plan, status: 'planned', result: null });
    return true;
  }

  async getBatch(batchId: string): Promise<StoredBatch | null> {
    return this.batches.get(batchId) ?? null;
  }

  async markApplied(batchId: string, result: unknown): Promise<boolean> {
    const b = this.batches.get(batchId);
    if (!b || b.status === 'applied') return false;
    this.batches.set(batchId, { ...b, status: 'applied', result });
    return true;
  }

  async getContactIdForSource(sourceKey: string): Promise<string | null> {
    return this.sources.get(sourceKey) ?? null;
  }

  async recordSource(sourceKey: string, contactId: string): Promise<void> {
    this.sources.set(sourceKey, contactId);
  }

  async suggestLabel(contactId: string, label: ImportLabel): Promise<void> {
    const cur = this.labels.get(contactId);
    this.labels.set(contactId, { suggested: label, label: cur?.label ?? null });
  }

  async getLabel(contactId: string) {
    return this.labels.get(contactId) ?? null;
  }
}

export class PgImportStore implements ImportStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async savePlan(batchId: string, inputHash: string, plan: unknown): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO contact_import_batches (batch_id, input_hash, plan)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (batch_id) DO UPDATE
         SET input_hash = EXCLUDED.input_hash, plan = EXCLUDED.plan, created_at = now()
         WHERE contact_import_batches.status = 'planned'
       RETURNING batch_id`,
      [batchId, inputHash, JSON.stringify(plan)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async getBatch(batchId: string): Promise<StoredBatch | null> {
    const r = await this.pool.query<{ batch_id: string; input_hash: string; plan: unknown; status: 'planned' | 'applied'; result: unknown }>(
      'SELECT batch_id, input_hash, plan, status, result FROM contact_import_batches WHERE batch_id = $1',
      [batchId],
    );
    const row = r.rows[0];
    return row ? { batchId: row.batch_id, inputHash: row.input_hash, plan: row.plan, status: row.status, result: row.result } : null;
  }

  async markApplied(batchId: string, result: unknown): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE contact_import_batches SET status = 'applied', result = $2::jsonb, applied_at = now()
       WHERE batch_id = $1 AND status = 'planned' RETURNING batch_id`,
      [batchId, JSON.stringify(result)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async getContactIdForSource(sourceKey: string): Promise<string | null> {
    const r = await this.pool.query<{ contact_id: string }>(
      'SELECT contact_id FROM contact_import_sources WHERE source_key = $1',
      [sourceKey],
    );
    return r.rows[0]?.contact_id ?? null;
  }

  async recordSource(sourceKey: string, contactId: string, batchId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO contact_import_sources (source_key, contact_id, last_batch_id) VALUES ($1, $2, $3)
       ON CONFLICT (source_key) DO UPDATE SET contact_id = EXCLUDED.contact_id, last_batch_id = EXCLUDED.last_batch_id, updated_at = now()`,
      [sourceKey, contactId, batchId],
    );
  }

  async suggestLabel(contactId: string, label: ImportLabel): Promise<void> {
    await this.pool.query(
      `INSERT INTO contact_import_labels (contact_id, suggested_label) VALUES ($1, $2)
       ON CONFLICT (contact_id) DO UPDATE SET suggested_label = EXCLUDED.suggested_label, updated_at = now()`,
      [contactId, label],
    );
  }

  async getLabel(contactId: string) {
    const r = await this.pool.query<{ suggested_label: ImportLabel | null; label: ImportLabel | null }>(
      'SELECT suggested_label, label FROM contact_import_labels WHERE contact_id = $1',
      [contactId],
    );
    const row = r.rows[0];
    return row ? { suggested: row.suggested_label, label: row.label } : null;
  }
}
