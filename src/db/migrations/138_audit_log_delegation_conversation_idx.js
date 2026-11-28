/**
 * 138 — Index for the History screen (ADR-072).
 *
 * Opening a conversation also shows the specialist conversations it delegated to, found by
 * payload.metadata.delegationOrigin.conversationId on their agent.task rows.
 *
 * Plain JS with pgm.noTransaction(), mirroring 105: a blocking build would hold a write lock on
 * audit_log, the write-ahead hook behind every bus publish.
 */

const NAME = 'idx_audit_log_delegation_conversation';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction();

  // A failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would then skip (see 087).
  const invalid = await pgm.db.select(
    `SELECT 1 FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND NOT i.indisvalid`,
    [NAME],
  );
  if (invalid.length > 0) {
    pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${NAME}`);
  }
  pgm.sql(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NAME}
    ON audit_log ((payload->'metadata'->'delegationOrigin'->>'conversationId'))
    WHERE event_type = 'agent.task'
      AND (payload->'metadata'->'delegationOrigin'->>'conversationId') IS NOT NULL`);
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${NAME}`);
}
