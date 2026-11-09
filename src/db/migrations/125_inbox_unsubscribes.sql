-- Newsletters the owner unsubscribed from through Curia (POST /phone/unsubscribe answered "unsubscribed").
-- If the sender keeps mailing, triage repeats the one-click request up to three times, then moves the mail to Trash.
-- One row per mailbox and sender address (lower-case). No mail text is kept.
CREATE TABLE inbox_unsubscribes (
  account_id TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Retries made so far (0 to 3) and when the last one was sent.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  last_attempt_at TIMESTAMPTZ,
  -- Set once mail from this sender has been moved to Trash; from then on every new mail from it goes there.
  trashed_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, sender_address)
);
