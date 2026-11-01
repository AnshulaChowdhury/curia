// Integration test — migration 103 against a live Postgres: existing vectors are stamped
// text-embedding-3-small, and the CHECK refuses a vector without its model (#2023). Runs
// in a scratch database migrated to 102, then applies 103 alone, so later migrations never
// run here. Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../src/db/migrations');

const MIGRATIONS_BEFORE_103 = readdirSync(MIGRATIONS_DIR)
  .filter(name => /^\d+_/.test(name) && Number.parseInt(name, 10) < 103)
  .length;

const vector = (value: number) => `[${Array.from({ length: 1536 }, () => value).join(',')}]`;

describeIf('migration 103: kg_nodes.embedding_model and kg_reembed_runs', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;

  async function migrate103(): Promise<void> {
    await runner({
      databaseUrl: scratch.url,
      dir: MIGRATIONS_DIR,
      migrationsTable: 'pgmigrations',
      direction: 'up',
      count: 1,
      log: () => {},
    });
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(DATABASE_URL!, 'mig103', { migrations: MIGRATIONS_BEFORE_103 });
    pool = new pg.Pool({ connectionString: scratch.url });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  it('stamps existing vectors and leaves unembedded rows unstamped', async () => {
    const { rows: [embedded] } = await pool.query<{ id: string }>(
      "INSERT INTO kg_nodes (type, label, source, embedding) VALUES ('person', 'Before 103', 'test', $1::vector) RETURNING id",
      [vector(0.1)],
    );
    const { rows: [bare] } = await pool.query<{ id: string }>(
      "INSERT INTO kg_nodes (type, label, source) VALUES ('person', 'Never embedded', 'test') RETURNING id",
    );

    await migrate103();
    const { rows: applied } = await pool.query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
    expect(applied[0]!.name).toBe('103_add_kg_embedding_model');

    const { rows } = await pool.query<{ id: string; embedding_model: string | null }>(
      'SELECT id, embedding_model FROM kg_nodes WHERE id = ANY($1)',
      [[embedded!.id, bare!.id]],
    );
    const byId = new Map(rows.map(r => [r.id, r.embedding_model]));
    expect(byId.get(embedded!.id)).toBe('text-embedding-3-small');
    expect(byId.get(bare!.id)).toBeNull();
  });

  it('refuses a vector stored without its model, and a model without a vector', async () => {
    await expect(pool.query(
      "INSERT INTO kg_nodes (type, label, source, embedding) VALUES ('person', 'Unstamped', 'test', $1::vector)",
      [vector(0.2)],
    )).rejects.toThrow(/kg_nodes_embedding_model_stamped/);
    await expect(pool.query(
      "INSERT INTO kg_nodes (type, label, source, embedding_model) VALUES ('person', 'Stamp only', 'test', 'm')",
    )).rejects.toThrow(/kg_nodes_embedding_model_stamped/);
  });
});
