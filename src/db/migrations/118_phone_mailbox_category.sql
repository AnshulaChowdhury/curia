-- Which of the owner's mailboxes is Work and which is Personal, as reported by the Command Hub phone launcher
-- (PUT /phone/inbox/accounts/{id}/category). The phone is the source of truth: Curia keeps the last value it was told,
-- never edits or infers it, and never expires it. One row per phone-inbox account id; a mailbox that was never
-- reported has no row, and the contact import skips it. No address is stored here.
CREATE TABLE phone_mailbox_categories (
  account_id TEXT PRIMARY KEY CHECK (account_id IN ('personal', 'moonray', 'work-outlook')),
  category TEXT NOT NULL CHECK (category IN ('WORK', 'PERSONAL')),
  -- Last time the phone told us (even if the value did not change).
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last time the value itself changed.
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
