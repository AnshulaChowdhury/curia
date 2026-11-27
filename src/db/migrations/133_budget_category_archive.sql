-- Up Migration
-- A budget category with transactions is archived, not deleted: its transactions keep it (so past months still add up)
-- and nothing new can be put in it. Only an empty category can be deleted.

-- Deleting a used category must fail. The old rule (SET NULL) would also have broken the category/source check.
ALTER TABLE budget_transactions DROP CONSTRAINT budget_transactions_category_id_fkey;
ALTER TABLE budget_transactions ADD CONSTRAINT budget_transactions_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES budget_categories (id) ON DELETE RESTRICT;

-- Enforced here so that every writer (owner, import, bank sync, a later agent) obeys it, including one racing an archive:
-- the share lock makes an assignment wait for an archive in progress and then see it.
CREATE FUNCTION budget_refuse_archived_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  archived TIMESTAMPTZ;
BEGIN
  IF NEW.category_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.category_id IS NOT DISTINCT FROM OLD.category_id THEN RETURN NEW; END IF;
  END IF;
  SELECT archived_at INTO archived FROM budget_categories WHERE id = NEW.category_id FOR SHARE;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'That category is archived' USING ERRCODE = 'check_violation', CONSTRAINT = 'budget_category_archived';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER budget_transactions_category_open BEFORE INSERT OR UPDATE OF category_id ON budget_transactions
  FOR EACH ROW EXECUTE FUNCTION budget_refuse_archived_category();

-- Until now "delete" hid a category after taking it off its transactions. Those empty leftovers go for good.
DELETE FROM budget_categories c
WHERE c.archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM budget_transactions t WHERE t.category_id = c.id);

-- Down Migration
DROP TRIGGER IF EXISTS budget_transactions_category_open ON budget_transactions;
DROP FUNCTION IF EXISTS budget_refuse_archived_category();
ALTER TABLE budget_transactions DROP CONSTRAINT budget_transactions_category_id_fkey;
ALTER TABLE budget_transactions ADD CONSTRAINT budget_transactions_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES budget_categories (id) ON DELETE SET NULL;
