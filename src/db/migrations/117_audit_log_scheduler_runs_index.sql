-- Up Migration

-- The Jobs page lists a job's runs by conversation id prefix (`scheduler:<jobId>:`). The existing conversation index
-- cannot serve a LIKE prefix under a non-C collation; text_pattern_ops can, and the partial predicate keeps it small.
CREATE INDEX idx_audit_scheduler_conversation
  ON audit_log (conversation_id text_pattern_ops)
  WHERE conversation_id LIKE 'scheduler:%';

-- Down Migration

DROP INDEX idx_audit_scheduler_conversation;
