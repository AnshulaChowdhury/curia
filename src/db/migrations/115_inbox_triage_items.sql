-- Real-time inbox triage memory: one row per message the watcher has looked at, so a restart never classifies it again.
-- Mail the classifier could not sort (it said "none", or the call or the label failed) keeps its sender, subject and a short
-- preview so the owner can pick a category from the phone (GET/POST /phone/triage/review). Sorted mail keeps ids only.
CREATE TABLE inbox_triage_items (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'tagged', 'none', 'failed', 'resolved')),
  thread_id TEXT,
  sender TEXT,
  subject TEXT,
  snippet TEXT,
  received_at TIMESTAMPTZ,
  resolved_group TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, message_id)
);
-- The review list: unsorted mail, newest first.
CREATE INDEX inbox_triage_items_unsorted_idx ON inbox_triage_items (received_at DESC) WHERE outcome IN ('none', 'failed');
