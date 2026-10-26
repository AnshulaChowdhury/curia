-- 108_disclosure_decisions.sql
--
-- The principal's yes or no on a personal-data ask, per thread (#2312, authority-aware PII).
--
-- A band-review hold that waits on the principal's yes to a requester stores its ask beside the
-- approval row (autonomy_action_log.disclosure_ask), never inside the replayed skill payload.
-- Approving the row records 'yes' for each (counterparty, label) of the ask, denying it 'no'.
-- Band review reads the latest decision per (conversation, counterparty, label): a yes
-- authorizes exactly that, a no turns a later ask there into a bounce. Labels and recipient
-- identifiers only, never the shared values. counterparty is the lowercased recipient id.

-- Up Migration

CREATE TABLE disclosure_decisions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  label TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('yes', 'no')),
  decided_by TEXT NOT NULL,
  action_ref TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_disclosure_decisions_lookup
  ON disclosure_decisions (conversation_id, counterparty, label, created_at DESC);

ALTER TABLE autonomy_action_log
  ADD COLUMN disclosure_ask JSONB;

-- Down Migration

ALTER TABLE autonomy_action_log
  DROP COLUMN IF EXISTS disclosure_ask;

DROP TABLE IF EXISTS disclosure_decisions;
