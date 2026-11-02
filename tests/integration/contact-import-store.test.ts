// Contacts import store against real Postgres: the SQL behind the dry-run / apply flow (migration 112).
// Skips without DATABASE_URL.
//
// The properties that matter:
//   - an applied batch is final: it cannot be re-planned or applied a second time;
//   - the same outside record always maps to one contact;
//   - an import can suggest a label but can never overwrite a decision a person made;
//   - the tables only accept the three labels, and a decision always carries its time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { PgImportStore } from '../../src/contacts-import/import-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('contact import store', () => {
  let pool: pg.Pool;
  let store: PgImportStore;
  const batches: string[] = [];
  const contactIds: string[] = [];
  const newBatch = () => { const id = `t-${randomBytes(6).toString('hex')}`; batches.push(id); return id; };
  const newContact = async () => {
    const r = await pool.query<{ id: string }>("INSERT INTO contacts (display_name) VALUES ('Import Test Person') RETURNING id");
    contactIds.push(r.rows[0]!.id);
    return r.rows[0]!.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new PgImportStore(pool);
  });

  afterAll(async () => {
    if (batches.length > 0) await pool.query('DELETE FROM contact_import_batches WHERE batch_id = ANY($1::text[])', [batches]);
    if (contactIds.length > 0) await pool.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [contactIds]);
    await pool.end();
  });

  it('saves a plan, lets a not-yet-applied plan be replaced, and reads it back', async () => {
    const id = newBatch();
    expect(await store.savePlan(id, 'hash-1', { items: [1] })).toBe(true);
    expect(await store.savePlan(id, 'hash-2', { items: [2] })).toBe(true);
    expect(await store.getBatch(id)).toMatchObject({ batchId: id, inputHash: 'hash-2', plan: { items: [2] }, status: 'planned', result: null });
    expect(await store.getBatch('no-such-batch')).toBeNull();
  });

  it('applies a batch exactly once, and an applied batch can no longer be re-planned', async () => {
    const id = newBatch();
    await store.savePlan(id, 'h', { items: [] });
    expect(await store.markApplied(id, { created: 1 })).toBe(true);
    expect(await store.markApplied(id, { created: 99 })).toBe(false);
    expect(await store.savePlan(id, 'other', { items: ['x'] })).toBe(false);
    expect(await store.getBatch(id)).toMatchObject({ inputHash: 'h', status: 'applied', result: { created: 1 } });
    expect(await store.markApplied('no-such-batch', {})).toBe(false);
  });

  it('applies a batch once even when two requests race', async () => {
    const id = newBatch();
    await store.savePlan(id, 'h', { items: [] });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.markApplied(id, {})));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('maps an outside record to one contact and updates the mapping on a re-send', async () => {
    const [a, b] = [await newContact(), await newContact()];
    const key = `src:${randomBytes(4).toString('hex')}`;
    expect(await store.getContactIdForSource(key)).toBeNull();
    await store.recordSource(key, a, 'batch-a');
    await store.recordSource(key, a, 'batch-b');
    expect(await store.getContactIdForSource(key)).toBe(a);
    await store.recordSource(key, b, 'batch-c');
    expect(await store.getContactIdForSource(key)).toBe(b);
    const { rows } = await pool.query('SELECT 1 FROM contact_import_sources WHERE source_key = $1', [key]);
    expect(rows).toHaveLength(1);
  });

  it('suggests a label, replaces the suggestion, and never overwrites a decision', async () => {
    const c = await newContact();
    expect(await store.getLabel(c)).toBeNull();
    await store.suggestLabel(c, 'work');
    await store.suggestLabel(c, 'hybrid');
    expect(await store.getLabel(c)).toEqual({ suggested: 'hybrid', label: null });
    // A person decides (Slice 5 will do this through its own atomic update).
    await pool.query("UPDATE contact_import_labels SET label = 'personal', decided_at = now(), decided_via = 'console' WHERE contact_id = $1", [c]);
    await store.suggestLabel(c, 'work');
    expect(await store.getLabel(c)).toEqual({ suggested: 'work', label: 'personal' });
  });

  it('rejects labels outside work / personal / hybrid, and a decision without its time', async () => {
    const c = await newContact();
    await expect(pool.query("INSERT INTO contact_import_labels (contact_id, suggested_label) VALUES ($1, 'boss')", [c])).rejects.toThrow();
    await expect(pool.query("INSERT INTO contact_import_labels (contact_id, label) VALUES ($1, 'work')", [c])).rejects.toThrow();
    await expect(pool.query("INSERT INTO contact_import_batches (batch_id, input_hash, plan, status) VALUES ('x', 'h', '{}', 'weird')")).rejects.toThrow();
  });

  it('forgets a contact\'s mapping and label when the contact is deleted', async () => {
    const c = await newContact();
    const key = `src:${randomBytes(4).toString('hex')}`;
    await store.recordSource(key, c, 'b');
    await store.suggestLabel(c, 'work');
    await pool.query('DELETE FROM contacts WHERE id = $1', [c]);
    expect(await store.getContactIdForSource(key)).toBeNull();
    expect(await store.getLabel(c)).toBeNull();
  });
});
