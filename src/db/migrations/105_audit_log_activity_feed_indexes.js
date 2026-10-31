/**
 * 105 — Partial indexes for the console activity feed (#2251).
 *
 * AuditLogRepo.findActivityJobs runs on every console home load:
 *
 *   - Roots: the newest agent.task rows in a window that no other task delegated
 *     (payload.metadata.delegationOrigin.taskEventId IS NULL), ORDER BY timestamp DESC, id DESC.
 *     The single-column event_type and timestamp indexes leave Postgres filtering the JSON path
 *     row by row; idx_audit_log_activity_roots holds exactly those rows, in read order.
 *   - Delegated tasks: agent.task rows whose delegationOrigin.taskEventId is one of the roots.
 *     idx_audit_log_delegation_origin is an expression index on that path.
 *
 * Plain JS with pgm.noTransaction(), mirroring 087: CREATE INDEX CONCURRENTLY cannot run in the
 * transaction node-pg-migrate wraps `.sql` files in, and a blocking build would hold a write lock
 * on audit_log — the write-ahead hook behind every bus publish — for the whole build.
 */

const INDEXES = [
  {
    name: 'idx_audit_log_activity_roots',
    sql: `ON audit_log (timestamp DESC, id DESC)
          WHERE event_type = 'agent.task'
            AND (payload->'metadata'->'delegationOrigin'->>'taskEventId') IS NULL`,
  },
  {
    name: 'idx_audit_log_delegation_origin',
    sql: `ON audit_log ((payload->'metadata'->'delegationOrigin'->>'taskEventId'))
          WHERE event_type = 'agent.task'
            AND (payload->'metadata'->'delegationOrigin'->>'taskEventId') IS NOT NULL`,
  },
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction();

  for (const index of INDEXES) {
    // A failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would then skip
    // (see 087). Drop only an invalid one, so a healthy index is never rebuilt.
    const invalid = await pgm.db.select(
      `SELECT 1 FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1 AND NOT i.indisvalid`,
      [index.name],
    );
    if (invalid.length > 0) {
      pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
    }
    pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ${index.sql}`);
  }
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.noTransaction();

  for (const index of INDEXES) {
    pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
  }
}
