-- 107_task_outreach.sql
--
-- Who Curia contacted for a task (email, web forms, calls, ...), so a later reply from that
-- counterparty can be linked back to the task (#2312, authority-aware PII).
--
-- A row is "open" until closed_at is set (the task finished) or expires_at passes (30 days).
-- domains and addresses are stored lowercased by TaskOutreachRepo; contact_ids are resolved
-- contacts. task_id is NULL for live-turn outreach, which is keyed by conversation_id instead.

-- Up Migration

CREATE TABLE task_outreach (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NULL REFERENCES tasks(id) ON DELETE CASCADE,
  root_task_id UUID NULL,
  conversation_id TEXT NULL,
  directing_event_id TEXT NULL,
  originator JSONB NOT NULL,
  via TEXT NOT NULL,
  org_name TEXT NULL,
  domains TEXT[] NOT NULL DEFAULT '{}',
  addresses TEXT[] NOT NULL DEFAULT '{}',
  contact_ids UUID[] NOT NULL DEFAULT '{}',
  given_contact TEXT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'
);

CREATE INDEX idx_task_outreach_open ON task_outreach (created_at DESC) WHERE closed_at IS NULL;
CREATE INDEX idx_task_outreach_domains ON task_outreach USING GIN (domains);
CREATE INDEX idx_task_outreach_addresses ON task_outreach USING GIN (addresses);
CREATE INDEX idx_task_outreach_contact_ids ON task_outreach USING GIN (contact_ids);
CREATE INDEX idx_task_outreach_task_id ON task_outreach (task_id);

-- Rollback:
--   DROP TABLE task_outreach;
