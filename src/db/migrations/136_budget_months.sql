-- Up Migration
-- A category is spending, income or savings, and may have its own budget for a particular month. A month without one uses
-- the category's usual monthly amount (monthly_cents).
ALTER TABLE budget_categories ADD COLUMN kind text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'savings'));

CREATE TABLE budget_month_amounts (
  category_id uuid NOT NULL REFERENCES budget_categories (id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  cents integer NOT NULL CHECK (cents >= 0),
  PRIMARY KEY (category_id, month)
);

-- Down Migration
DROP TABLE IF EXISTS budget_month_amounts;
ALTER TABLE budget_categories DROP COLUMN IF EXISTS kind;
