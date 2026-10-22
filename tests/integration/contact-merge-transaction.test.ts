// Integration test — ContactService.mergeContacts is one transaction (#1695).
//
// The in-memory backend cannot prove this: it has no rollback, so a unit test can only
// check that the client is threaded and that the post-commit notifications stay quiet.
// What needs a live Postgres is the guarantee itself — when a write in the middle of the
// sequence fails, every earlier write in it is undone.
//
// The failure is forced with a BEFORE DELETE trigger scoped by id to the secondary
// contact, so the last write in the sequence (deleteContact) raises while the four
// writes before it have already run. Nothing else in the database is affected, and the
// trigger is dropped in afterEach.
//
// Every fixture row is created by this suite and deleted by id in afterEach.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

const FAIL_TRIGGER = 'itest_1695_block_secondary_delete';

describeIf('mergeContacts transactionality (#1695)', () => {
  let pool: pg.Pool;
  let contactService: ContactService;
  let contactServiceWithKg: ContactService;
  let entityMemory: EntityMemory;

  const createdContactIds: string[] = [];
  const createdKgNodeIds: string[] = [];

  /** Insert a contact directly: kg_node_id stays NULL so no KG merge is attempted. */
  async function makeContact(displayName: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name, kg_node_id) VALUES ($1, NULL) RETURNING id`,
      [displayName],
    );
    const id = rows[0]!.id;
    createdContactIds.push(id);
    return id;
  }

  async function addIdentity(contactId: string, channel: string, identifier: string): Promise<void> {
    await pool.query(
      `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, source)
       VALUES ($1, $2, $3, 'itest-1695')`,
      [contactId, channel, identifier],
    );
  }

  async function addOverride(contactId: string, permission: string): Promise<void> {
    await pool.query(
      `INSERT INTO contact_auth_overrides (contact_id, permission, granted, granted_by)
       VALUES ($1, $2, true, 'itest-1695')`,
      [contactId, permission],
    );
  }

  /** Identity owner rows for the fixture contacts, ordered so comparisons are stable. */
  async function identityOwners(): Promise<Array<{ contactId: string; identifier: string }>> {
    const { rows } = await pool.query<{ contact_id: string; channel_identifier: string }>(
      `SELECT contact_id, channel_identifier FROM contact_channel_identities
       WHERE contact_id = ANY($1::uuid[]) ORDER BY channel_identifier`,
      [createdContactIds],
    );
    return rows.map(r => ({ contactId: r.contact_id, identifier: r.channel_identifier }));
  }

  async function overrideOwners(): Promise<Array<{ contactId: string; permission: string }>> {
    const { rows } = await pool.query<{ contact_id: string; permission: string }>(
      `SELECT contact_id, permission FROM contact_auth_overrides
       WHERE contact_id = ANY($1::uuid[]) ORDER BY permission`,
      [createdContactIds],
    );
    return rows.map(r => ({ contactId: r.contact_id, permission: r.permission }));
  }

  async function exclusionRows(): Promise<Array<{ a: string; b: string }>> {
    const { rows } = await pool.query<{ contact_a_id: string; contact_b_id: string }>(
      `SELECT contact_a_id, contact_b_id FROM contact_dedup_exclusions
       WHERE contact_a_id = ANY($1::uuid[]) OR contact_b_id = ANY($1::uuid[])
       ORDER BY contact_a_id, contact_b_id`,
      [createdContactIds],
    );
    return rows.map(r => ({ a: r.contact_a_id, b: r.contact_b_id }));
  }

  /**
   * Make DELETE on one specific contact row raise, so the merge's final write fails
   * with the four writes before it already applied inside the transaction.
   */
  async function blockDeleteOf(contactId: string): Promise<void> {
    await pool.query(
      `CREATE OR REPLACE FUNCTION ${FAIL_TRIGGER}() RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'forced merge failure (#1695 integration test)';
       END;
       $$ LANGUAGE plpgsql`,
    );
    // DDL cannot take bind parameters, so the id is quoted by Postgres itself via
    // format(%L) and the resulting statement is then executed — never string-concatenated
    // in JS. The WHEN clause keeps the trigger scoped to this suite's own contact row, so
    // suites running in parallel against the same database are untouched.
    const { rows } = await pool.query<{ sql: string }>(
      `SELECT format(
         $fmt$CREATE TRIGGER ${FAIL_TRIGGER} BEFORE DELETE ON contacts
              FOR EACH ROW WHEN (OLD.id = %L::uuid)
              EXECUTE FUNCTION ${FAIL_TRIGGER}()$fmt$,
         $1::uuid
       ) AS sql`,
      [contactId],
    );
    await pool.query(rows[0]!.sql);
  }

  async function unblockDelete(): Promise<void> {
    await pool.query(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON contacts`);
    await pool.query(`DROP FUNCTION IF EXISTS ${FAIL_TRIGGER}()`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // This suite creates and drops a trigger on the shared `contacts` table, so it must
    // never point at a real database even though every row it writes is its own.
    await requireCuriaTestDatabase(pool);

    // No EntityMemory on the original service: the fixtures have kg_node_id = NULL, so
    // mergeContacts skips the KG merge entirely and those tests need no embeddings.
    contactService = ContactService.createWithPostgres(pool, undefined, createSilentLogger());

    const logger = createSilentLogger();
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);
    contactServiceWithKg = ContactService.createWithPostgres(pool, entityMemory, logger);

    // Fails fast when migration 084 has not been applied.
    await pool.query('SELECT 1 FROM contact_dedup_exclusions LIMIT 0');
  });

  afterEach(async () => {
    // Drop the trigger first — otherwise fixture teardown hits it too.
    await unblockDelete();
    if (createdContactIds.length > 0) {
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [createdContactIds]);
      createdContactIds.length = 0;
    }
    if (createdKgNodeIds.length > 0) {
      await pool.query(
        `DELETE FROM kg_edges WHERE source_node_id = ANY($1::uuid[]) OR target_node_id = ANY($1::uuid[])`,
        [createdKgNodeIds],
      );
      await pool.query(`DELETE FROM kg_nodes WHERE id = ANY($1::uuid[])`, [createdKgNodeIds]);
      createdKgNodeIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls the whole write sequence back when the final write fails', async () => {
    const primary = await makeContact('Tx Primary 1695');
    const secondary = await makeContact('Tx Secondary 1695');
    const other = await makeContact('Tx Bystander 1695');

    await addIdentity(primary, 'email', 'tx-primary-1695@example.com');
    await addIdentity(secondary, 'email', 'tx-secondary-1695@example.com');
    await addOverride(primary, 'itest:1695:primary-perm');
    await addOverride(secondary, 'itest:1695:secondary-perm');
    // A CEO ruling held by the secondary: exactly the row #1625 moved into this sequence.
    await contactService.addDedupExclusion(secondary, other, 'itest-1695');

    const identitiesBefore = await identityOwners();
    const overridesBefore = await overrideOwners();
    const exclusionsBefore = await exclusionRows();

    await blockDeleteOf(secondary);

    await expect(contactService.mergeContacts(primary, secondary, false))
      .rejects.toThrow(/forced merge failure/);

    // Both contacts survive — the golden-record update on the primary is rolled back too.
    const { rows: survivors } = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM contacts WHERE id = ANY($1::uuid[]) ORDER BY display_name`,
      [[primary, secondary]],
    );
    expect(survivors).toHaveLength(2);

    // Identities, overrides and the CEO ruling are all exactly where they were: nothing
    // was left re-pointed onto a survivor whose golden record was never written.
    expect(await identityOwners()).toEqual(identitiesBefore);
    expect(await overrideOwners()).toEqual(overridesBefore);
    expect(await exclusionRows()).toEqual(exclusionsBefore);
    expect(exclusionsBefore).toHaveLength(1);
    expect(exclusionsBefore[0]).toEqual({
      a: secondary < other ? secondary : other,
      b: secondary < other ? other : secondary,
    });
  });

  it('leaves both KG nodes untouched when the contact-merge transaction rolls back (#1711)', async () => {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const error = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error,
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as never;
    const loggedService = ContactService.createWithPostgres(pool, entityMemory, logger);

    const primary = await contactServiceWithKg.createContact({
      displayName: `Tx KG Primary ${runId}`,
      source: 'itest-1711',
    });
    const secondary = await contactServiceWithKg.createContact({
      displayName: `Tx KG Secondary ${runId}`,
      source: 'itest-1711',
    });
    createdContactIds.push(primary.id, secondary.id);
    expect(primary.kgNodeId).toBeTruthy();
    expect(secondary.kgNodeId).toBeTruthy();
    createdKgNodeIds.push(primary.kgNodeId!, secondary.kgNodeId!);

    await entityMemory.storeFact({
      entityNodeId: secondary.kgNodeId!,
      label: `Secondary-only fact ${runId}`,
      source: 'itest-1711',
    });
    const secondaryFactsBefore = await entityMemory.getFacts(secondary.kgNodeId!);
    expect(secondaryFactsBefore).toHaveLength(1);
    createdKgNodeIds.push(secondaryFactsBefore[0]!.id);

    await blockDeleteOf(secondary.id);

    await expect(loggedService.mergeContacts(primary.id, secondary.id, false))
      .rejects.toThrow(/forced merge failure/);

    expect(error.mock.calls.some(([, msg]) => String(msg).includes('may already have been applied'))).toBe(false);
    expect(error.mock.calls.some(([, msg]) => String(msg).includes('KG nodes were not touched'))).toBe(true);

    expect(await entityMemory.getEntity(primary.kgNodeId!)).toBeDefined();
    expect(await entityMemory.getEntity(secondary.kgNodeId!)).toBeDefined();
    const secondaryFactsAfter = (await entityMemory.getFacts(secondary.kgNodeId!)).map(f => f.label);
    expect(secondaryFactsAfter).toEqual([`Secondary-only fact ${runId}`]);
    expect(await entityMemory.getFacts(primary.kgNodeId!)).toHaveLength(0);
  });

  it('commits the same sequence when nothing fails', async () => {
    // The mirror of the rollback case: without the trigger the identical fixture merges,
    // which is what makes the assertions above evidence of rollback rather than of a
    // merge that never started.
    const primary = await makeContact('Commit Primary 1695');
    const secondary = await makeContact('Commit Secondary 1695');
    const other = await makeContact('Commit Bystander 1695');

    await addIdentity(secondary, 'email', 'commit-secondary-1695@example.com');
    await addOverride(secondary, 'itest:1695:moved-perm');
    await contactService.addDedupExclusion(secondary, other, 'itest-1695');

    await contactService.mergeContacts(primary, secondary, false);

    const { rows: survivors } = await pool.query<{ id: string }>(
      `SELECT id FROM contacts WHERE id = ANY($1::uuid[])`,
      [[primary, secondary]],
    );
    expect(survivors.map(r => r.id)).toEqual([primary]);

    expect(await identityOwners()).toEqual([
      { contactId: primary, identifier: 'commit-secondary-1695@example.com' },
    ]);
    expect(await overrideOwners()).toEqual([
      { contactId: primary, permission: 'itest:1695:moved-perm' },
    ]);
    expect(await exclusionRows()).toEqual([{
      a: primary < other ? primary : other,
      b: primary < other ? other : primary,
    }]);
  });

  it('never loses a scoring increment that lands while the merge is in flight (QA D)', async () => {
    // mergeContacts reads both contacts before its transaction. A message scored between
    // that read and the write used to be overwritten by the absolute counts the merge
    // computed from the stale read. The fold now locks both rows and computes the counters
    // from the locked values, so the increment survives.
    const primary = await makeContact('Counter Primary QA-D');
    const secondary = await makeContact('Counter Secondary QA-D');
    await pool.query(
      `UPDATE contacts SET inbound_message_count = 5, outbound_message_count = 1 WHERE id = $1`,
      [primary],
    );
    await pool.query(
      `UPDATE contacts SET inbound_message_count = 3, outbound_message_count = 2 WHERE id = $1`,
      [secondary],
    );

    // A second connection increments the primary's counters (as updateScoringFields does)
    // and holds the row lock, uncommitted, while the merge starts.
    const scorer = await pool.connect();
    let merge: Promise<unknown> | undefined;
    try {
      await scorer.query('BEGIN');
      await scorer.query(
        `UPDATE contacts SET inbound_message_count = inbound_message_count + 10,
                             outbound_message_count = outbound_message_count + 4,
                             last_seen_at = now()
         WHERE id = $1`,
        [primary],
      );

      const scorerXid = (await scorer.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;

      merge = contactService.mergeContacts(primary, secondary, false);
      // Wait until the merge is queued on the scorer's row lock (a row-lock wait is a wait
      // on the holder's transaction id), i.e. its pre-transaction read has already happened.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_locks
           WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1`,
          [scorerXid],
        );
        if (Number(rows[0]!.n) > 0) break;
        if (Date.now() > deadline) throw new Error('merge never waited on the scorer’s row lock');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await scorer.query('COMMIT');
    } catch (err) {
      await scorer.query('ROLLBACK');
      throw err;
    } finally {
      scorer.release();
    }
    await merge;

    const { rows } = await pool.query<{ inbound_message_count: number; outbound_message_count: number; last_seen_at: Date | null }>(
      `SELECT inbound_message_count, outbound_message_count, last_seen_at FROM contacts WHERE id = $1`,
      [primary],
    );
    expect(rows[0]).toMatchObject({ inbound_message_count: 5 + 10 + 3, outbound_message_count: 1 + 4 + 2 });
    expect(rows[0]!.last_seen_at).not.toBeNull();
  });
});
