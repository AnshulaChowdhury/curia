-- Up Migration
-- A sheet can be attached to one web chat conversation, so the budget specialist can read it from that chat and no other.
-- At most one sheet per conversation; attaching another detaches the first (it stays in the list of sheets).
ALTER TABLE budget_sheets ADD COLUMN conversation_id text CHECK (char_length(conversation_id) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX budget_sheets_conversation_idx ON budget_sheets (conversation_id) WHERE conversation_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS budget_sheets_conversation_idx;
ALTER TABLE budget_sheets DROP COLUMN IF EXISTS conversation_id;
