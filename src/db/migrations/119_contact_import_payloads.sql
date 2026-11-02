-- 119_contact_import_payloads.sql
--
-- The people a dry run was planned for, kept until the run is applied (or thrown away), so "Apply" can only do what
-- was previewed: the import service refuses an apply whose people differ from the reviewed plan. One row per batch;
-- a run is a set of batches (at most 500 people each) that share a run_id. Rows are deleted once the run is applied
-- and cascade away with their batch. This holds names and numbers from the owner's own contact lists, in Curia's own
-- database, like the contacts table itself; nothing here is logged.

-- Up Migration

CREATE TABLE contact_import_payloads (
  batch_id TEXT PRIMARY KEY REFERENCES contact_import_batches (batch_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  people JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_import_payloads_run ON contact_import_payloads (run_id);
