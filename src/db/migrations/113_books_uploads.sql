-- Bank files uploaded on the Books page. The bytes are kept only until the books run has recorded the file;
-- the row (name, size, sha256) stays so the same file is never taken twice.
CREATE TABLE books_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  content BYTEA,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'processed')),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX books_uploads_status_idx ON books_uploads (status, uploaded_at);
