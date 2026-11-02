-- The Command Hub morning brief (GET /phone/brief): one row per local day, written by the 6:30 job and served as is.
-- `payload` holds the sections (plain-text items, newsletter summaries included). An empty brief is still stored, so the
-- job runs once a day and an empty day answers 204 instead of retrying.
CREATE TABLE phone_briefs (
  brief_date DATE PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);
