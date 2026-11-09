-- What the owner has told triage about a sender, so the classifier can be given it as a hint.
-- Written only when the owner says yes on the phone after choosing a category for a review card
-- (POST /phone/triage/preferences). `value` is a lower-case address (scope sender) or domain (scope domain).
CREATE TABLE inbox_triage_preferences (
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('sender', 'domain')),
  value TEXT NOT NULL,
  group_name TEXT NOT NULL CHECK (group_name IN ('urgent', 'drafted', 'seen', 'newsletter', 'spam')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, scope, value)
);

-- The review card needs the sender's address to offer "save this for the sender?". Kept like the other card text:
-- only for unsorted mail, and cleared when the owner resolves it.
ALTER TABLE inbox_triage_items ADD COLUMN sender_address TEXT;
