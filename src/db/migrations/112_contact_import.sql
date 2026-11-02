-- 112_contact_import.sql
--
-- Contacts import (Curia as the source of truth for contacts). Three small tables; nothing here changes the
-- contacts or contact_channel_identities tables.
--
--   contact_import_batches  a dry-run plan, kept so an apply can only do what was reviewed (and only once)
--   contact_import_sources  which outside record (a `sourceKey`, e.g. a bridge's contact id) became which contact,
--                           so re-sending the same record updates it instead of creating a duplicate
--   contact_import_labels   the work / personal / hybrid label: a suggestion from the import, and the person's
--                           decision. The decision is final once made (first response wins).

-- Up Migration

CREATE TABLE contact_import_batches (
  batch_id TEXT PRIMARY KEY,
  -- SHA-256 of the people sent with the dry run. An apply must send the same people.
  input_hash TEXT NOT NULL,
  plan JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'applied')),
  result JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ NULL
);

CREATE TABLE contact_import_sources (
  source_key TEXT PRIMARY KEY,
  contact_id UUID NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  last_batch_id TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_import_sources_contact ON contact_import_sources (contact_id);

CREATE TABLE contact_import_labels (
  contact_id UUID PRIMARY KEY REFERENCES contacts (id) ON DELETE CASCADE,
  suggested_label TEXT NULL CHECK (suggested_label IN ('work', 'personal', 'hybrid')),
  -- The decision. NULL until a person decides; never overwritten by an import.
  label TEXT NULL CHECK (label IN ('work', 'personal', 'hybrid')),
  decided_at TIMESTAMPTZ NULL,
  decided_via TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((label IS NULL) = (decided_at IS NULL))
);
