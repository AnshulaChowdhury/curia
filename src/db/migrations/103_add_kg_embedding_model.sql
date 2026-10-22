-- 103_add_kg_embedding_model.sql
--
-- Stamps each knowledge-graph vector with the model that made it (ADR-051).
-- Existing vectors get text-embedding-3-small: upstream Curia only ever used that model, so an upgraded install keeps its graph on.
-- The CHECK makes a write path that stores a vector without its model fail at the insert.
-- kg_reembed_runs holds one row per re-embed, open while finished_at is null. A null vector cannot tell an interrupted re-embed from a node never embedded (principal and agent nodes, and the contact nodes from migrations 056 and 085), so the run record is the only signal.

-- Up Migration

ALTER TABLE kg_nodes ADD COLUMN embedding_model TEXT;

UPDATE kg_nodes SET embedding_model = 'text-embedding-3-small' WHERE embedding IS NOT NULL;

ALTER TABLE kg_nodes
  ADD CONSTRAINT kg_nodes_embedding_model_stamped
  CHECK ((embedding IS NULL) = (embedding_model IS NULL));

CREATE TABLE kg_reembed_runs (
  id                BIGSERIAL PRIMARY KEY,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  target_model      TEXT NOT NULL,
  target_dimensions INTEGER NOT NULL,
  rows_total        INTEGER NOT NULL DEFAULT 0,
  rows_done         INTEGER NOT NULL DEFAULT 0
);

-- Down Migration

DROP TABLE IF EXISTS kg_reembed_runs;
ALTER TABLE kg_nodes DROP CONSTRAINT IF EXISTS kg_nodes_embedding_model_stamped;
ALTER TABLE kg_nodes DROP COLUMN IF EXISTS embedding_model;
