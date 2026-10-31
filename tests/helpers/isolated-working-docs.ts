// isolated-working-docs.ts — a private, empty copy of the working-document tables.
//
// Integration files run in parallel against one Postgres, and some of them clear
// `working_documents` wholesale (tests/integration/working-docs-repo.test.ts does in
// beforeEach). A suite that needs a known store — or an *empty* one, like the export →
// import round trip (#1824) — gets its own schema instead: the same table definitions,
// copied with LIKE … INCLUDING ALL, reached through a pool whose search_path points at
// it. WorkingDocsRepo's unqualified table names then resolve there, untouched by
// anything else.
//
// It creates and drops a schema, so it refuses any database but `curia_test` — in both
// directions, for every caller (require-test-db.ts).
//
// The `task_id → tasks` foreign key is not copied (LIKE never copies foreign keys);
// these stores hold no task-linked rows.

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireCuriaTestDatabase } from '../integration/require-test-db.js';

export interface IsolatedWorkingDocsStore {
  pool: pg.Pool;
  schema: string;
  /** Close the pool and drop the schema. */
  drop(): Promise<void>;
}

export async function createIsolatedWorkingDocsStore(databaseUrl: string): Promise<IsolatedWorkingDocsStore> {
  // Generated from a UUID, so safe to interpolate as an identifier.
  const schema = `wd_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await requireCuriaTestDatabase(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.working_documents (LIKE public.working_documents INCLUDING ALL)`);
    await admin.query(`CREATE TABLE ${schema}.working_document_links (LIKE public.working_document_links INCLUDING ALL)`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  return {
    pool,
    schema,
    async drop() {
      await pool.end();
      const cleanup = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await requireCuriaTestDatabase(cleanup);
        await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
