-- 110_books_graph_snapshot.sql
--
-- The accounting rules graph for the Knowledge Graph page. The graph itself lives on the books Mac mini
-- (Oxigraph); it pushes a read-only snapshot (rules, accounts, tax codes, locations, classes, payees; never
-- transactions) and Curia keeps only the latest one. A single-row table: the CHECK on `id` allows exactly one row.

-- Up Migration

CREATE TABLE books_graph_snapshot (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  snapshot JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
