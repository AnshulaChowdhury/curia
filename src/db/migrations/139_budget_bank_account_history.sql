-- Up Migration
-- Every bank account a Plaid connection has reported, kept after the connection is removed. It is how the sync knows
-- that an account is already connected through another login, or was connected before and has transactions stored.
-- Plaid gives the same real account a new account_id on every connection, so an account is recognised by its
-- institution, kind, subtype and last digits.
CREATE TABLE budget_bank_account_history (
  external_id     text PRIMARY KEY,                    -- Plaid account_id
  link_id         uuid REFERENCES budget_bank_links(id) ON DELETE SET NULL,  -- null: the connection was removed
  institution     text NOT NULL CHECK (char_length(institution) BETWEEN 1 AND 120),
  mask            text CHECK (mask IS NULL OR char_length(mask) <= 8),
  kind            text NOT NULL,                       -- budget_accounts.type
  subtype         text,
  label           text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),  -- budget_transactions.account
  label_pinned    boolean NOT NULL DEFAULT false,      -- a re-added account keeps the name its transactions already have
  blocked         boolean NOT NULL DEFAULT false,      -- already connected elsewhere: nothing is imported for it
  import_after    date,                                -- re-added: nothing dated before this is imported
  seen_that_day   integer[] NOT NULL DEFAULT '{}',     -- amounts already stored on import_after, each skipped once
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_bank_account_history_link_idx ON budget_bank_account_history (link_id);

-- Accounts connected today. Their subtype was never stored; an empty one matches any.
INSERT INTO budget_bank_account_history (external_id, link_id, institution, mask, kind, label)
SELECT a.external_id, a.link_id, l.institution, a.mask, a.type,
       left(coalesce(nullif(l.accounts ->> a.external_id, ''), l.institution || ' ' || a.name || coalesce(' ••' || a.mask, '')), 60)
FROM budget_accounts a
JOIN budget_bank_links l ON l.id = a.link_id;

-- Down Migration
DROP TABLE IF EXISTS budget_bank_account_history;
