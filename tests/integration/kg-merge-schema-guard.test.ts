// Integration test — schema guard for the contact and KG node merges (#2233).
//
// A merge deletes the merged-away contact row and archives the absorbed KG node. Every
// foreign key that points at contacts(id) or kg_nodes(id) must therefore be handled by the
// merge, or its rows are cascade-deleted, nulled, or left blocking the delete — the data
// loss #2233 fixed. This test reads the live foreign keys from pg_constraint and fails on
// any one that is not in the explicit "handled by merge" list below, so a new FK added in
// a future migration cannot silently reintroduce that loss.
//
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

/**
 * Every FK column referencing contacts(id), keyed "table.column", with the merge step
 * that carries its rows onto the surviving contact (src/contacts/contact-service.ts).
 */
const CONTACT_REFERENCES_HANDLED_BY_MERGE: Record<string, string> = {
  'contact_channel_identities.contact_id': 'reattachIdentities',
  'contact_auth_overrides.contact_id': 'reattachAuthOverrides',
  'contact_dedup_exclusions.contact_a_id': 'reattachDedupExclusions',
  'contact_dedup_exclusions.contact_b_id': 'reattachDedupExclusions',
  'contact_calendars.contact_id': 'reattachContactReferences',
  'grant_recommendations.contact_id': 'reattachContactReferences',
  'conversation_resolved_entities.contact_id': 'reattachContactReferences',
  'tasks.waiting_on_contact_id': 'reattachContactReferences',
  'voice_sessions.caller_contact_id': 'reattachContactReferences',
  'working_memory.sender_contact_id': 'reattachContactReferences',
};

/**
 * Every FK column referencing kg_nodes(id), keyed "table.column", with the merge step that
 * moves it off the absorbed node (src/kg-merge/executor.ts).
 */
const KG_NODE_REFERENCES_HANDLED_BY_MERGE: Record<string, string> = {
  // The contact row itself: re-pointed (or folded) before the absorbed node is archived,
  // and the executor refuses to archive a node a contact still links to.
  'contacts.kg_node_id': 'executeMerge contact re-points / mergeContactRowsInTx',
  // Edges: moved, collapsed or dropped; fact link edges re-linked or cascaded with the
  // deleted fact; the executor refuses to archive a node with a live edge left.
  'kg_edges.source_node_id': 'executeMerge edges + fact links',
  'kg_edges.target_node_id': 'executeMerge edges + fact links',
};

describeIf('merge schema guard — every FK to contacts / kg_nodes is handled (#2233)', () => {
  let pool: pg.Pool;

  /** "table.column" for every single-column FK referencing the given table's id. */
  async function referencesTo(table: 'contacts' | 'kg_nodes'): Promise<string[]> {
    const { rows } = await pool.query<{ ref: string }>(
      `SELECT c.conrelid::regclass::text || '.' || a.attname AS ref
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f' AND c.confrelid = to_regclass($1)
       ORDER BY 1`,
      [table],
    );
    return rows.map(r => r.ref);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('every foreign key to contacts(id) is carried over by the contact merge', async () => {
    const found = await referencesTo('contacts');
    expect(found.length).toBeGreaterThan(0);
    const unhandled = found.filter(ref => !(ref in CONTACT_REFERENCES_HANDLED_BY_MERGE));
    expect(
      unhandled,
      `New foreign key(s) to contacts(id): ${unhandled.join(', ')}. A merge deletes the merged-away `
      + 'contact, so these rows would be cascade-deleted, nulled or would block the delete. Re-point them in '
      + 'reattachContactReferences (src/contacts/contact-service.ts, both backends), then add the column to '
      + 'CONTACT_REFERENCES_HANDLED_BY_MERGE in this test.',
    ).toEqual([]);
    // A listed FK that no longer exists means the list has gone stale — keep it exact.
    const stale = Object.keys(CONTACT_REFERENCES_HANDLED_BY_MERGE).filter(ref => !found.includes(ref));
    expect(stale, `Listed but no longer a foreign key to contacts(id): ${stale.join(', ')}`).toEqual([]);
  });

  it('every foreign key to kg_nodes(id) is moved off the absorbed node by the node merge', async () => {
    const found = await referencesTo('kg_nodes');
    expect(found.length).toBeGreaterThan(0);
    const unhandled = found.filter(ref => !(ref in KG_NODE_REFERENCES_HANDLED_BY_MERGE));
    expect(
      unhandled,
      `New foreign key(s) to kg_nodes(id): ${unhandled.join(', ')}. A node merge archives the absorbed `
      + 'node, so these rows would stay attached to a tombstone. Move them in executeMerge '
      + '(src/kg-merge/executor.ts) — or, for a contact-owned table, in reattachContactReferences — then add '
      + 'the column to KG_NODE_REFERENCES_HANDLED_BY_MERGE in this test.',
    ).toEqual([]);
    const stale = Object.keys(KG_NODE_REFERENCES_HANDLED_BY_MERGE).filter(ref => !found.includes(ref));
    expect(stale, `Listed but no longer a foreign key to kg_nodes(id): ${stale.join(', ')}`).toEqual([]);
  });
});
