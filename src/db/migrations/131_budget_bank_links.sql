-- Plaid bank connections for the personal budget. The access token is NOT here: it lives in the encrypted vault
-- under plaid_access_<id>. This table holds only what the console shows and what the next sync needs.
CREATE TABLE budget_bank_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution     text NOT NULL CHECK (char_length(institution) BETWEEN 1 AND 120),
  plaid_item_id   text NOT NULL UNIQUE,
  cursor          text,
  accounts        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- plaid account_id -> display label ("Tangerine Chequing ••1234")
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_login', 'error')),
  last_error      text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
