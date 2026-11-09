-- 127_contact_export_log.sql
--
-- Status lines written by the contacts job on the Mac mini, shown in the Sources drawer so a failed or empty run can be
-- diagnosed without opening a terminal on the mini. They may contain chat partner names, phone numbers and room ids (the
-- owner asked for that); never message text. Only the newest 500 lines are kept. (126 is taken by inbox_triage_progress.)

-- Up Migration

CREATE TABLE contact_export_log (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL CHECK (char_length(message) <= 600)
);
