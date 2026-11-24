-- Up Migration
-- Personal budgeting (owner-only; no agent reads it except the opt-in budget specialist, ADR-062). Amounts are integer
-- cents, negative = money out. Payee and description come from bank files and are untrusted text.
CREATE TABLE budget_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  -- Monthly budget in cents; NULL = a category with no budget set.
  monthly_cents INTEGER CHECK (monthly_cents IS NULL OR monthly_cents >= 0),
  rollover BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_budget_categories_name ON budget_categories (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE budget_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account TEXT NOT NULL CHECK (char_length(account) BETWEEN 1 AND 60),
  txn_date DATE NOT NULL,
  payee TEXT NOT NULL DEFAULT '' CHECK (char_length(payee) <= 200),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  amount_cents INTEGER NOT NULL,
  category_id UUID NULL REFERENCES budget_categories (id) ON DELETE SET NULL,
  -- How the category was chosen; NULL while uncategorised.
  source TEXT NULL CHECK (source IN ('rule', 'agent_guess', 'you')),
  rule_id TEXT NULL,
  confidence NUMERIC(3, 2) NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- Same account, date, amount and text twice is the same transaction: an import never adds it again.
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((category_id IS NULL) = (source IS NULL))
);
CREATE INDEX idx_budget_transactions_date ON budget_transactions (txn_date);
CREATE INDEX idx_budget_transactions_category ON budget_transactions (category_id, txn_date);

-- The categorisation rules, kept as one YAML document the owner edits. One row.
CREATE TABLE budget_rules (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  yaml TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS budget_rules;
DROP TABLE IF EXISTS budget_transactions;
DROP TABLE IF EXISTS budget_categories;
