-- Up Migration

-- A short human name for a scheduled job, shown on the Jobs page. Optional: jobs made before this have none.
ALTER TABLE scheduled_jobs ADD COLUMN name TEXT;

ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_name_length CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120);

-- The books monitor's two weekly jobs were created before names existed.
UPDATE scheduled_jobs SET name = 'Books: Monday upload reminder'
 WHERE name IS NULL AND created_by = 'books' AND task_payload->>'books_job' = 'reminder';
UPDATE scheduled_jobs SET name = 'Books: Tuesday deadline check'
 WHERE name IS NULL AND created_by = 'books' AND task_payload->>'books_job' = 'deadline';

-- Down Migration

ALTER TABLE scheduled_jobs DROP CONSTRAINT scheduled_jobs_name_length;
ALTER TABLE scheduled_jobs DROP COLUMN name;
