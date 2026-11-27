-- Up Migration
-- Changes to the budget that the assistant has proposed in a web chat. Nothing happens until the owner approves one in
-- that chat; at most one waits per conversation, and it lapses after a day.
CREATE TABLE budget_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL CHECK (char_length(conversation_id) BETWEEN 1 AND 200),
  changes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded', 'replaced')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  decided_at timestamptz
);
CREATE UNIQUE INDEX budget_proposals_pending_idx ON budget_proposals (conversation_id) WHERE status = 'pending';

-- Down Migration
DROP TABLE IF EXISTS budget_proposals;
