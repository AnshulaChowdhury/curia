-- 109_books_batches.sql
--
-- Books review: a weekly batch of bank rows pushed by the books agent on the Mac mini, reviewed and
-- approved on the console's Books page, then pulled back by the agent and posted to QuickBooks.
--
-- `data` is the row exactly as pushed (untrusted JSON from a bank file). A person's changes to the
-- editable fields live in `edits` and are merged over `data` on read, so a re-push of the same batch
-- can never overwrite a decision. `result` is the posting outcome the agent reports.

-- Up Migration

CREATE TABLE books_batches (
  batch_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  report JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE books_batch_rows (
  batch_id TEXT NOT NULL REFERENCES books_batches (batch_id) ON DELETE CASCADE,
  row_id TEXT NOT NULL,
  data JSONB NOT NULL,
  edits JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'skipped')),
  decided_at TIMESTAMPTZ NULL,
  result JSONB NULL,
  PRIMARY KEY (batch_id, row_id)
);

-- The agent polls for approved rows that have no result yet.
CREATE INDEX idx_books_batch_rows_approved
  ON books_batch_rows (batch_id)
  WHERE decision = 'approved' AND result IS NULL;
