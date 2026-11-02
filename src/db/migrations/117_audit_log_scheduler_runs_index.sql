-- Up Migration

-- The Jobs page lists a job's runs by conversation id prefix (`scheduler:<jobId>:`). The existing conversation index
-- cannot serve a LIKE prefix under a non-C collation; text_pattern_ops can. It is not partial on the `scheduler:` prefix:
-- Postgres cannot prove `LIKE 'scheduler:<id>:%'` implies `LIKE 'scheduler:%'`, so such an index would never be chosen.
CREATE INDEX idx_audit_conversation_prefix
  ON audit_log (conversation_id text_pattern_ops)
  WHERE conversation_id IS NOT NULL;

-- Down Migration

DROP INDEX idx_audit_conversation_prefix;
