// pipeline-state-store.ts — what the books pipeline remembers between runs, kept in Postgres (one row).

import type { DbPool } from '../db/connection.js';
import type { PipelineState } from './books-service-client.js';

export class PipelineStateStore {
  constructor(private readonly pool: DbPool) {}

  /** null before the first run. */
  async load(): Promise<PipelineState | null> {
    const { rows } = await this.pool.query<{ state: PipelineState }>('SELECT state FROM books_pipeline_state WHERE id = 1');
    return rows[0]?.state ?? null;
  }

  async save(state: PipelineState): Promise<void> {
    await this.pool.query(
      `INSERT INTO books_pipeline_state (id, state, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [JSON.stringify(state)],
    );
  }
}
