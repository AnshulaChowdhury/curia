-- "From this sender, about these words" rules for triage hints. The words are picked from the email by the phone's prompt
-- and confirmed by the owner; a rule is one sender plus a sorted set of lower-case words, so one sender can have several.
ALTER TABLE inbox_triage_preferences DROP CONSTRAINT inbox_triage_preferences_scope_check;
ALTER TABLE inbox_triage_preferences
  ADD CONSTRAINT inbox_triage_preferences_scope_check CHECK (scope IN ('sender', 'domain', 'sender-keywords'));
ALTER TABLE inbox_triage_preferences ADD COLUMN keywords TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE inbox_triage_preferences DROP CONSTRAINT inbox_triage_preferences_pkey;
ALTER TABLE inbox_triage_preferences ADD PRIMARY KEY (account_id, scope, value, keywords);
