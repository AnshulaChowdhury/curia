// Cleanup candidates against real Postgres: only contacts the import created from a mailbox for people never written to.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PgCleanupStore } from '../../src/contacts-import/cleanup-service.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('import cleanup candidates', () => {
  let pool: pg.Pool;
  let store: PgCleanupStore;
  const created: string[] = [];
  const clean = async () => {
    for (const t of ['contact_farm_facts', 'contact_import_labels', 'contact_import_sources', 'contact_import_batches']) await pool.query(`DELETE FROM ${t}`);
    await pool.query("DELETE FROM contacts WHERE display_name LIKE 'CLEANUP-%'");
    created.length = 0;
  };
  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await requireCuriaTestDatabase(pool); store = new PgCleanupStore(pool); });
  beforeEach(clean);
  afterAll(async () => { await clean(); await pool.end(); });

  async function mk(name: string, email: string, opts: { source?: string; notes?: string; extraIdentity?: boolean; createdByImport?: boolean } = {}): Promise<string> {
    const c = await pool.query<{ id: string }>("INSERT INTO contacts (display_name, tier, notes) VALUES ($1, 'unknown', $2) RETURNING id", [`CLEANUP-${name}`, opts.notes ?? null]);
    const id = c.rows[0]!.id;
    await pool.query("INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, source) VALUES ($1, 'email', $2, 'bulk_import')", [id, email]);
    if (opts.extraIdentity) await pool.query("INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, source) VALUES ($1, 'phone', $2, 'bulk_import')", [id, `+1555${Math.floor(Math.random() * 1e7)}`]);
    await pool.query('INSERT INTO contact_import_sources (source_key, contact_id) VALUES ($1, $2)', [opts.source ?? `mailbox:moonray:${email}`, id]);
    if (opts.createdByImport !== false) created.push(id);
    return id;
  }
  const batch = () => pool.query(
    "INSERT INTO contact_import_batches (batch_id, input_hash, plan, status, result) VALUES ('b1', 'h', '{}', 'applied', $1)",
    [JSON.stringify({ outcomes: created.map((contactId) => ({ outcome: 'created', contactId })) })]);
  const fact = (email: string, sent: number) => pool.query(
    "INSERT INTO contact_farm_facts (account_id, email, domain, received, sent, copied, first_seen, last_seen) VALUES ('personal', $1, 'x.com', 1, $2, 0, now(), now())",
    [email, sent]);

  it('finds only one-way, untouched, import-created mailbox contacts', async () => {
    const one = await mk('oneway', 'news@kijiji.ca');
    await fact('news@kijiji.ca', 0);
    await mk('wrote-to', 'friend@x.com');
    await fact('Friend@x.com', 2);
    const labelled = await mk('labelled', 'l@x.com');
    await pool.query("INSERT INTO contact_import_labels (contact_id, label, decided_at) VALUES ($1, 'work', now())", [labelled]);
    await mk('noted', 'n@x.com', { notes: 'met at a conference' });
    await mk('two-identities', 't@x.com', { extraIdentity: true });
    await mk('bridge-too', 'b@x.com', { source: 'bridge:whatsapp:1' });
    await mk('attached', 'a@x.com', { createdByImport: false });
    await batch();
    const found = await store.findOneWayImports(100);
    expect(found.map((c) => c.contactId)).toEqual([one]);
    expect(found[0]).toMatchObject({ email: 'news@kijiji.ca' });
  });
});
