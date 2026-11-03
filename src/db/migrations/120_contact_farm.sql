-- 120_contact_farm.sql
--
-- The interim "farm" for the contacts import (Step 1). Mailboxes are read once, in the background, into per-person
-- counts; nothing here is a contact and nothing here holds message content (no subjects, bodies or message ids).
--
--   contact_farm_runs   one row per mailbox: where the scan is (a Nylas page cursor), so a stopped scan resumes
--   contact_farm_facts  one row per (mailbox, address): how often they wrote, how often I wrote them, first/last seen

-- Up Migration

CREATE TABLE contact_farm_runs (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'done', 'failed')),
  -- Only mail newer than this is read (ten years back from the start).
  window_start TIMESTAMPTZ NOT NULL,
  cursor TEXT NULL,
  messages_scanned BIGINT NOT NULL DEFAULT 0,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL
);

CREATE TABLE contact_farm_facts (
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  domain TEXT NOT NULL,
  display_name TEXT NULL,
  -- They wrote to me.
  received INTEGER NOT NULL DEFAULT 0,
  -- I wrote to them (To or Cc).
  sent INTEGER NOT NULL DEFAULT 0,
  -- They were copied on a message between other people.
  copied INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, email)
);

CREATE INDEX idx_contact_farm_facts_email ON contact_farm_facts (email);
CREATE INDEX idx_contact_farm_facts_domain ON contact_farm_facts (domain);
