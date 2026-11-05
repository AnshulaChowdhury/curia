-- Up Migration
-- What the books pipeline remembers between weekly runs (files already processed, transactions seen for de-duplication,
-- the last closing balance per account). One row. The books service keeps nothing itself; Curia hands this back to it
-- on every call and stores what comes back.
CREATE TABLE books_pipeline_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS books_pipeline_state;
