-- 111_books_monitor.sql
--
-- Books deadline and heartbeat monitoring (FR-INT-5, FR-INT-7). The Mac mini reports every run and checks in every
-- 15 minutes; Curia watches for a missed weekly deadline, a failed run, a file nobody processed, and a silent Mac mini.
--
-- books_heartbeat holds one row (id = 1): the Mac mini's last check-in. books_runs keeps every run report (the report is
-- untrusted JSON from the agent, capped at 256 KB by the route). books_monitor_state is a small key/value store for what
-- the monitor has already notified, so a condition is announced once and then repeated daily, not every 15 minutes.

-- Up Migration

CREATE TABLE books_heartbeat (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  last_seen_at TIMESTAMPTZ NOT NULL,
  state TEXT NULL,
  version TEXT NULL,
  last_run_at TIMESTAMPTZ NULL
);

CREATE TABLE books_runs (
  id BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed', 'deferred')),
  batch_id TEXT NULL,
  accounts_received TEXT[] NOT NULL DEFAULT '{}',
  expected_accounts TEXT[] NOT NULL DEFAULT '{}',
  files TEXT[] NOT NULL DEFAULT '{}',
  report JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX books_runs_received_at_idx ON books_runs (received_at DESC);

CREATE TABLE books_monitor_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
