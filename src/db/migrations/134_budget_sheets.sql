-- Up Migration
-- Spreadsheets the owner is working on for the budget (shown in Univer). Only the cleaned workbook is kept, never the
-- uploaded file. Each save bumps the version so two writers cannot silently overwrite one another. A sheet expires
-- 14 days after its last change.
CREATE TABLE budget_sheets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  snapshot    jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '14 days'
);

-- Down Migration
DROP TABLE IF EXISTS budget_sheets;
