-- Assets and debts for the personal budget's net-worth view. A row with a link_id comes from a connected bank and is
-- refreshed by the sync (and goes away with the link); a row without one was entered by the owner.
-- Balances are integer cents. An asset's balance is what it is worth; a debt's balance is what is owed.
CREATE TABLE budget_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id        uuid REFERENCES budget_bank_links(id) ON DELETE CASCADE,
  external_id    text UNIQUE,                          -- Plaid account_id
  institution    text NOT NULL DEFAULT '' CHECK (char_length(institution) <= 120),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mask           text CHECK (mask IS NULL OR char_length(mask) <= 8),
  type           text NOT NULL CHECK (type IN ('cash', 'investment', 'property', 'vehicle', 'other_asset',
                                               'credit_card', 'line_of_credit', 'mortgage', 'loan', 'other_debt')),
  currency       text NOT NULL DEFAULT 'CAD' CHECK (char_length(currency) BETWEEN 1 AND 10),
  balance_cents  bigint,                               -- null when the bank gives no balance
  as_of          timestamptz NOT NULL DEFAULT now(),
  CHECK ((link_id IS NULL) = (external_id IS NULL))
);
CREATE INDEX budget_accounts_link_idx ON budget_accounts (link_id);
