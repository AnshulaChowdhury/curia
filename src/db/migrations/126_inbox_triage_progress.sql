-- Where real-time inbox triage resumes after a restart or an outage: the last time one mailbox was listed in full
-- and every message in that listing was handled.
CREATE TABLE inbox_triage_progress (
  account_id      TEXT        PRIMARY KEY,
  last_success_at TIMESTAMPTZ NOT NULL
);
