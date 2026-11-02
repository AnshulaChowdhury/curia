// Integration test — a contact merge carries the contacts-import tables over to the survivor (#2233).
//
// contact_import_sources and contact_import_labels (migration 112) reference contacts(id) with ON DELETE
// CASCADE, so without help a merge would silently delete them with the merged-away contact:
//   - a source mapping lost means the next re-send of that outside record creates a duplicate contact;
//   - a label decision lost means a person's answer is forgotten.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ContactService } from '../../src/contacts/contact-service.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('contact merge carries the contacts-import tables', () => {
  let pool: pg.Pool;
  let service: ContactService;
  const contactIds: string[] = [];
  const sourceKeys: string[] = [];

  async function makeContact(name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO contacts (display_name, kg_node_id) VALUES ($1, NULL) RETURNING id', [name]);
    contactIds.push(rows[0]!.id);
    return rows[0]!.id;
  }
  async function makeSource(contactId: string): Promise<string> {
    const key = `itest-2233:${randomBytes(4).toString('hex')}`;
    sourceKeys.push(key);
    await pool.query('INSERT INTO contact_import_sources (source_key, contact_id, last_batch_id) VALUES ($1, $2, $3)', [key, contactId, 'itest']);
    return key;
  }
  async function setLabel(contactId: string, suggested: string | null, decided?: { label: string; via: string }): Promise<void> {
    await pool.query(
      `INSERT INTO contact_import_labels (contact_id, suggested_label, label, decided_at, decided_via)
       VALUES ($1, $2, $3, $4, $5)`,
      [contactId, suggested, decided?.label ?? null, decided ? new Date('2026-11-02T10:00:00Z') : null, decided?.via ?? null],
    );
  }
  async function labelOf(contactId: string) {
    const { rows } = await pool.query<{ suggested_label: string | null; label: string | null; decided_via: string | null; decided_at: Date | null }>(
      'SELECT suggested_label, label, decided_via, decided_at FROM contact_import_labels WHERE contact_id = $1', [contactId]);
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    service = ContactService.createWithPostgres(pool, undefined, createSilentLogger());
    await pool.query('SELECT 1 FROM contact_import_labels LIMIT 0'); // fails fast without migration 112
  });

  afterEach(async () => {
    if (sourceKeys.length > 0) await pool.query('DELETE FROM contact_import_sources WHERE source_key = ANY($1::text[])', [sourceKeys]);
    sourceKeys.length = 0;
    if (contactIds.length > 0) await pool.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [contactIds]);
    contactIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('keeps the merged-away contact\'s source mappings, now pointing at the survivor', async () => {
    const primary = await makeContact('Merge Survivor 2233');
    const secondary = await makeContact('Merge Absorbed 2233');
    const keyP = await makeSource(primary);
    const keyS1 = await makeSource(secondary);
    const keyS2 = await makeSource(secondary);

    await service.mergeContacts(primary, secondary, false);

    const { rows } = await pool.query<{ source_key: string; contact_id: string }>(
      'SELECT source_key, contact_id FROM contact_import_sources WHERE source_key = ANY($1::text[])', [[keyP, keyS1, keyS2]]);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.contact_id).toBe(primary);
  });

  it('moves the label row across when the survivor has none', async () => {
    const primary = await makeContact('Merge Survivor 2233');
    const secondary = await makeContact('Merge Absorbed 2233');
    await setLabel(secondary, 'work', { label: 'hybrid', via: 'console' });

    await service.mergeContacts(primary, secondary, false);

    expect(await labelOf(primary)).toMatchObject({ suggested_label: 'work', label: 'hybrid', decided_via: 'console' });
  });

  it('keeps the survivor\'s own decision when both have decided, and drops the other', async () => {
    const primary = await makeContact('Merge Survivor 2233');
    const secondary = await makeContact('Merge Absorbed 2233');
    await setLabel(primary, 'personal', { label: 'personal', via: 'reply' });
    await setLabel(secondary, 'work', { label: 'work', via: 'console' });

    await service.mergeContacts(primary, secondary, false);

    expect(await labelOf(primary)).toMatchObject({ suggested_label: 'personal', label: 'personal', decided_via: 'reply' });
    const { rows } = await pool.query('SELECT 1 FROM contact_import_labels WHERE contact_id = ANY($1::uuid[])', [[primary, secondary]]);
    expect(rows).toHaveLength(1);
  });

  it('never loses a decision: the absorbed contact\'s answer moves over when the survivor has not decided', async () => {
    const primary = await makeContact('Merge Survivor 2233');
    const secondary = await makeContact('Merge Absorbed 2233');
    await setLabel(primary, 'personal'); // only a suggestion
    await setLabel(secondary, 'work', { label: 'work', via: 'reply' });

    await service.mergeContacts(primary, secondary, false);

    const after = await labelOf(primary);
    expect(after).toMatchObject({ suggested_label: 'personal', label: 'work', decided_via: 'reply' });
    expect(after?.decided_at).toEqual(new Date('2026-11-02T10:00:00Z'));
  });

  it('keeps a suggestion from either side when nobody has decided', async () => {
    const primary = await makeContact('Merge Survivor 2233');
    const secondary = await makeContact('Merge Absorbed 2233');
    await setLabel(primary, null);
    await setLabel(secondary, 'hybrid');

    await service.mergeContacts(primary, secondary, false);

    expect(await labelOf(primary)).toMatchObject({ suggested_label: 'hybrid', label: null, decided_at: null });
  });
});
