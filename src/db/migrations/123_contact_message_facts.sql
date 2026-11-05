-- 123_contact_message_facts.sql
--
-- Message activity per chat partner, exported from Matrix by the contacts job on the Mac mini (counts only: no message
-- text, no room ids, no event ids). (121 is taken twice on main; 122 is left free for the fix.)
--
--   contact_export_runs   a run request and its progress; Curia asks, the job answers
--   contact_export_rooms  rooms the job has finished in a run, so a restarted job skips them
--   contact_message_facts one row per (room, partner): messages they sent, messages I sent, first and last seen.
--                         Counts are absolute for the room (the job recomputes a room from scratch), so re-sending is safe.

-- Up Migration

CREATE TABLE contact_export_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'done', 'failed')),
  -- Only messages newer than this are counted.
  since TIMESTAMPTZ NOT NULL,
  rooms_done INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL
);

CREATE TABLE contact_export_rooms (
  run_id TEXT NOT NULL REFERENCES contact_export_runs (run_id) ON DELETE CASCADE,
  room_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, room_hash)
);

CREATE TABLE contact_message_facts (
  room_hash TEXT NOT NULL,
  ghost_id TEXT NOT NULL,
  network TEXT NOT NULL,
  display_name TEXT NULL,
  phone TEXT NULL,
  from_them INTEGER NOT NULL DEFAULT 0,
  from_me INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NULL,
  last_seen TIMESTAMPTZ NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (room_hash, ghost_id)
);

CREATE INDEX idx_contact_message_facts_phone ON contact_message_facts (phone) WHERE phone IS NOT NULL;
