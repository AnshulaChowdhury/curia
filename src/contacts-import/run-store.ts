// run-store.ts — the people behind a previewed import run, kept between "Preview" and "Apply" (table
// contact_import_payloads, migration 119). Two implementations behind one interface: Postgres and in-memory (tests).

import type { Pool } from 'pg';
import type { ImportPerson } from './import-service.js';

export interface RunChunk {
  batchId: string;
  people: ImportPerson[];
  /** ISO-8601, when the preview was made. */
  createdAt: string;
}

export interface RunStore {
  /** Saves one batch's people. The batch row (the plan) must already exist. */
  savePayload(runId: string, batchId: string, people: ImportPerson[]): Promise<void>;
  /** Every batch of a run, in the order they were saved. Empty when the run is unknown or already applied. */
  getRun(runId: string): Promise<RunChunk[]>;
  deleteRun(runId: string): Promise<void>;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunChunk[]>();

  async savePayload(runId: string, batchId: string, people: ImportPerson[]): Promise<void> {
    const chunks = this.runs.get(runId) ?? [];
    chunks.push({ batchId, people, createdAt: new Date().toISOString() });
    this.runs.set(runId, chunks);
  }

  async getRun(runId: string): Promise<RunChunk[]> {
    return [...(this.runs.get(runId) ?? [])];
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
}

export class PgRunStore implements RunStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async savePayload(runId: string, batchId: string, people: ImportPerson[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO contact_import_payloads (batch_id, run_id, people) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (batch_id) DO UPDATE SET run_id = EXCLUDED.run_id, people = EXCLUDED.people, created_at = now()`,
      [batchId, runId, JSON.stringify(people)],
    );
  }

  async getRun(runId: string): Promise<RunChunk[]> {
    const r = await this.pool.query<{ batch_id: string; people: ImportPerson[]; created_at: Date }>(
      'SELECT batch_id, people, created_at FROM contact_import_payloads WHERE run_id = $1 ORDER BY batch_id',
      [runId],
    );
    return r.rows.map((row) => ({ batchId: row.batch_id, people: row.people, createdAt: row.created_at.toISOString() }));
  }

  async deleteRun(runId: string): Promise<void> {
    await this.pool.query('DELETE FROM contact_import_payloads WHERE run_id = $1', [runId]);
  }
}
