-- Keeps the date of the owner's first unsubscribe from a sender, so the phone can show "days since" even when the owner
-- unsubscribes again (record() restarts unsubscribed_at, the retry clock, but never touches this column).
ALTER TABLE inbox_unsubscribes ADD COLUMN first_unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE inbox_unsubscribes SET first_unsubscribed_at = unsubscribed_at;
