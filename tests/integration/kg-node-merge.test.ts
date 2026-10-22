// Integration test — knowledge-graph node merge (#2233, docs/wip/2026-10-21-kg-node-merge-design.md §12).
//
// Real Postgres: the merge is one transaction across kg_nodes, kg_edges, contacts and every
// table that references a contact, under row locks and partial unique indexes that an
// in-memory backend cannot model.
//
// Every fixture row is created by this suite and deleted by id in afterEach. Labels carry a
// per-run suffix so label-tier nodes never collide with another run's leftovers.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../src/contacts/contact-service.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { embeddingStamp } from '../../src/memory/embedding-profiles.js';
import { createSilentLogger } from '../../src/logger.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { BusEvent } from '../../src/bus/events.js';
import { NodeMergeService, type Embedder, type NodeMergeServiceDeps } from '../../src/kg-merge/service.js';
import { InvalidResolutionError, MergeBlockedError, StalePreviewError } from '../../src/kg-merge/errors.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';

describeIf('KG node merge (#2233)', () => {
  let pool: pg.Pool;
  let onTestDb = false;
  let runId = '';

  const nodeIds: string[] = [];
  const contactIds: string[] = [];
  const taskIds: string[] = [];

  let publish: ReturnType<typeof vi.fn>;
  let onContactMerged: ReturnType<typeof vi.fn<(primaryId: string, secondaryId: string, mergedAt: Date) => void>>;
  let service: NodeMergeService;
  let baseDeps: NodeMergeServiceDeps;

  /** A service like `service`, with some dependencies swapped. */
  function serviceWith(overrides: Partial<NodeMergeServiceDeps>): NodeMergeService {
    return new NodeMergeService({ ...baseDeps, ...overrides });
  }

  // -- fixture helpers ------------------------------------------------------

  async function node(
    type: string,
    label: string,
    opts: {
      identitySource?: 'label' | 'contact';
      properties?: Record<string, unknown>;
      aliases?: string[];
      confidence?: number;
      lastConfirmedAt?: string;
      sensitivity?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, source, identity_source, aliases, confidence, last_confirmed_at, sensitivity)
       VALUES ($1, $2, $3::jsonb, 'test', $4, $5, $6, COALESCE($7::timestamptz, now()), $8)
       RETURNING id`,
      [
        type,
        // Fact labels are not in idx_kg_nodes_unique and are compared by content, so they
        // stay as written; entity labels get the run suffix.
        type === 'fact' ? label : `${label} ${runId}`,
        JSON.stringify(opts.properties ?? {}),
        opts.identitySource ?? 'label',
        opts.aliases ?? [],
        opts.confidence ?? 0.7,
        opts.lastConfirmedAt ?? null,
        opts.sensitivity ?? 'internal',
      ],
    );
    nodeIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function edge(source: string, target: string, type: string, properties: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_edges (source_node_id, target_node_id, type, properties, source)
       VALUES ($1, $2, $3, $4::jsonb, 'test') RETURNING id`,
      [source, target, type, JSON.stringify(properties)],
    );
    return rows[0]!.id;
  }

  async function fact(
    entityId: string,
    label: string,
    properties: Record<string, unknown> = {},
    opts: { confidence?: number; lastConfirmedAt?: string } = {},
  ): Promise<string> {
    const id = await node('fact', label, { properties, ...opts });
    await edge(entityId, id, 'relates_to');
    return id;
  }

  async function contact(opts: {
    displayName: string;
    kgNodeId: string | null;
    kind?: string;
    systemRole?: string | null;
    tier?: string;
    title?: string | null;
    location?: string | null;
    inbound?: number;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name, kg_node_id, kind, system_role, tier, title, location, inbound_message_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        opts.displayName,
        opts.kgNodeId,
        opts.kind ?? 'person',
        opts.systemRole ?? null,
        opts.tier ?? 'known',
        opts.title ?? null,
        opts.location ?? null,
        opts.inbound ?? 0,
      ],
    );
    contactIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function identity(contactId: string, channel: string, identifier: string, verified = true): Promise<void> {
    await pool.query(
      `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, verified, source)
       VALUES ($1, $2, $3, $4, 'ceo_stated')`,
      [contactId, channel, identifier, verified],
    );
  }

  async function task(waitingOn: string, originatorContactId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (agent_id, intent_anchor, error_budget, waiting_on_contact_id, originator)
       VALUES ('coordinator', 'kg merge test', '{}'::jsonb, $1, $2::jsonb) RETURNING id`,
      [waitingOn, JSON.stringify({ contactId: originatorContactId, systemRole: null, channel: 'email', initiatedAt: T1 })],
    );
    taskIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function nodeRow(id: string) {
    const { rows } = await pool.query<{
      id: string; type: string; label: string; aliases: string[]; properties: Record<string, unknown>;
      archived_at: Date | null; identity_source: string; embedding: string | null; embedding_model: string | null;
    }>(`SELECT id, type, label, aliases, properties, archived_at, identity_source, embedding::text AS embedding, embedding_model
        FROM kg_nodes WHERE id = $1`, [id]);
    return rows[0];
  }

  async function liveEdges(nodeId: string) {
    const { rows } = await pool.query<{ id: string; source_node_id: string; target_node_id: string; type: string; confidence: number }>(
      `SELECT id, source_node_id, target_node_id, type, confidence FROM kg_edges
       WHERE archived_at IS NULL AND (source_node_id = $1 OR target_node_id = $1) ORDER BY id`,
      [nodeId],
    );
    return rows;
  }

  async function factsOf(nodeId: string) {
    const { rows } = await pool.query<{ id: string; label: string; properties: Record<string, unknown> }>(
      `SELECT f.id, f.label, f.properties FROM kg_edges e
       JOIN kg_nodes f ON f.id = CASE WHEN e.source_node_id = $1 THEN e.target_node_id ELSE e.source_node_id END
       WHERE e.archived_at IS NULL AND e.type = 'relates_to' AND f.type = 'fact'
         AND (e.source_node_id = $1 OR e.target_node_id = $1)
       ORDER BY f.id`,
      [nodeId],
    );
    return rows;
  }

  async function contactRow(id: string) {
    const { rows } = await pool.query<{ id: string; kg_node_id: string | null; kind: string; display_name: string; title: string | null; location: string | null; tier: string; inbound_message_count: number }>(
      `SELECT id, kg_node_id, kind, display_name, title, location, tier, inbound_message_count FROM contacts WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function identitiesOf(contactId: string): Promise<string[]> {
    const { rows } = await pool.query<{ k: string }>(
      `SELECT channel || ':' || channel_identifier AS k FROM contact_channel_identities WHERE contact_id = $1 ORDER BY 1`,
      [contactId],
    );
    return rows.map(r => r.k);
  }

  function publishedTypes(): string[] {
    return publish.mock.calls.map(call => (call[1] as BusEvent).type);
  }

  async function principalExists(): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM contacts WHERE system_role = 'principal'`);
    return rows.length > 0;
  }

  // -- lifecycle ------------------------------------------------------------

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
  });

  beforeEach(() => {
    runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    publish = vi.fn().mockResolvedValue(undefined);
    onContactMerged = vi.fn<(primaryId: string, secondaryId: string, mergedAt: Date) => void>();
    const logger = createSilentLogger();
    const contactService = ContactService.createWithPostgres(pool, undefined, logger, { onContactMerged });
    baseDeps = {
      pool,
      contactService,
      bus: { publish } as unknown as EventBus,
      logger,
      embedder: EmbeddingService.createForTesting(),
    };
    service = new NodeMergeService(baseDeps);
  });

  afterEach(async () => {
    if (!onTestDb) return;
    if (taskIds.length > 0) {
      await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [taskIds]);
      taskIds.length = 0;
    }
    if (contactIds.length > 0) {
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [contactIds]);
      contactIds.length = 0;
    }
    if (nodeIds.length > 0) {
      await pool.query(
        `DELETE FROM kg_edges WHERE source_node_id = ANY($1::uuid[]) OR target_node_id = ANY($1::uuid[])`,
        [nodeIds],
      );
      await pool.query(`DELETE FROM kg_nodes WHERE id = ANY($1::uuid[])`, [nodeIds]);
      nodeIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  // -- 1. person + person ---------------------------------------------------

  it('person + person: one node and one contact remain, with every reference and fact carried over', async () => {
    const s = await node('person', 'Jane Doe', { identitySource: 'contact', lastConfirmedAt: T1 });
    const a = await node('person', 'J. Doe', { identitySource: 'contact', lastConfirmedAt: T2, aliases: ['janie'] });
    const cs = await contact({ displayName: 'Jane Doe', kgNodeId: s, title: 'CEO', inbound: 2 });
    const ca = await contact({ displayName: 'J. Doe', kgNodeId: a, title: 'CTO', location: 'Paris', inbound: 3 });
    await identity(cs, 'email', `jane-${runId}@example.com`);
    // (channel, identifier) is globally unique — case-insensitively for email — so two
    // contacts can never hold the same identity; the union is a plain move.
    await identity(ca, 'signal', `+1555${Date.now() % 10_000_000}`);

    // Associated contact data on the absorbed contact.
    await pool.query(
      `INSERT INTO contact_calendars (nylas_calendar_id, contact_id, label, is_primary) VALUES ($1, $2, 'Work', true)`,
      [`cal-${runId}`, ca],
    );
    await pool.query(
      `INSERT INTO grant_recommendations (contact_id, permission, reasoning) VALUES ($1, 'send_email', 'test')`,
      [ca],
    );
    const t = await task(ca, ca);

    // Facts: a conflicting title, a duplicate, and one that moves.
    const sTitle = await fact(s, 'Title: CEO', { attribute: 'title', value: 'CEO' }, { lastConfirmedAt: T1 });
    const aTitle = await fact(a, 'Title: CTO', { attribute: 'title', value: 'CTO' }, { lastConfirmedAt: T2 });
    const sSail = await fact(s, 'Loves sailing');
    const aDup = await fact(a, 'loves sailing.');
    const aMove = await fact(a, 'Has two dogs');

    // Edges: one collides with a survivor edge, one moves, one becomes a self-loop.
    const x = await node('project', 'Apollo');
    const y = await node('organization', 'Acme');
    const sWorks = await edge(s, x, 'works_on');
    await edge(x, a, 'works_on');
    const aMember = await edge(a, y, 'member_of');
    await edge(a, s, 'collaborates_with');

    const preview = await service.preview(s, a);
    expect(preview.blockers).toEqual([]);
    expect(preview.contactPlan).toMatchObject({ action: 'merge', survivingContactId: cs, mergedContactIds: [ca] });
    expect(preview.conflicts.facts.map(f => f.id)).toEqual([`fact:${sTitle}:${aTitle}`]);
    expect(preview.conflicts.contactFields.map(c => c.field)).toEqual(['title']);
    expect(preview.summary).toMatchObject({ edgesMoved: 1, edgesCollapsed: 1, edgesDropped: 1 });

    const result = await service.apply({
      survivorId: s,
      absorbedId: a,
      planToken: preview.planToken,
      resolutions: { facts: { [`fact:${sTitle}:${aTitle}`]: 'survivor' }, contactFields: { title: 'absorbed' } },
      actor: null,
    });
    expect(result.dryRun).toBe(false);
    expect(result.contactMerge).toEqual({ survivingContactId: cs, mergedContactIds: [ca], repointedContactIds: [] });
    expect(result.node).toMatchObject({ id: s, type: 'person', identitySource: 'contact' });
    expect(result.node.aliases).toEqual(expect.arrayContaining([`j. doe ${runId}`, 'janie']));
    expect(result.summary.contactReferencesRepointed).toBeGreaterThanOrEqual(4);

    // Contacts: one remains, identities unioned, attributes resolved, counters summed.
    expect(await contactRow(ca)).toBeUndefined();
    expect(await contactRow(cs)).toMatchObject({ kg_node_id: s, title: 'CTO', location: 'Paris', inbound_message_count: 5 });
    expect(await identitiesOf(cs)).toHaveLength(2);

    // Associated data re-pointed, not cascade-deleted / nulled.
    const cal = await pool.query(`SELECT contact_id FROM contact_calendars WHERE nylas_calendar_id = $1`, [`cal-${runId}`]);
    expect(cal.rows[0]?.contact_id).toBe(cs);
    const grant = await pool.query(`SELECT contact_id FROM grant_recommendations WHERE contact_id = $1`, [cs]);
    expect(grant.rows).toHaveLength(1);
    const taskRow = await pool.query<{ waiting_on_contact_id: string; originator: { contactId: string } }>(
      `SELECT waiting_on_contact_id, originator FROM tasks WHERE id = $1`, [t],
    );
    expect(taskRow.rows[0]).toMatchObject({ waiting_on_contact_id: cs, originator: { contactId: cs } });

    // Facts: conflict resolved to the survivor with previous_values; duplicate collapsed; one moved.
    const facts = await factsOf(s);
    expect(facts.map(f => f.id).sort()).toEqual([sTitle, aMove, sSail].sort());
    const title = facts.find(f => f.id === sTitle)!;
    expect(title.properties.previous_values).toEqual([
      expect.objectContaining({ value: 'CTO', reason: 'node_merge' }),
    ]);
    expect(await nodeRow(aTitle)).toBeUndefined();
    expect(await nodeRow(aDup)).toBeUndefined();

    // Edges: collapsed onto the survivor's, moved in place, self-loop gone.
    const edges = await liveEdges(s);
    expect(edges.filter(e => e.type === 'works_on').map(e => e.id)).toEqual([sWorks]);
    expect(edges.find(e => e.id === aMember)).toMatchObject({ source_node_id: s, target_node_id: y });
    expect(edges.some(e => e.type === 'collaborates_with')).toBe(false);

    // Absorbed node is a tombstone with no live edges.
    const tomb = await nodeRow(a);
    expect(tomb!.archived_at).not.toBeNull();
    expect(tomb!.properties).toMatchObject({ merged_into: s });
    expect(await liveEdges(a)).toEqual([]);

    // Audit + contact.merged callback.
    expect(publishedTypes()).toEqual(['kg.nodes_merged']);
    const event = publish.mock.calls[0]![1] as Extract<BusEvent, { type: 'kg.nodes_merged' }>;
    expect(publish.mock.calls[0]![0]).toBe('system');
    expect(event.payload).toMatchObject({ survivorId: s, absorbedId: a, crossType: false, actor: null });
    expect(event.payload.resolutions.contactFields).toEqual({ title: 'absorbed' });
    expect(onContactMerged).toHaveBeenCalledWith(cs, ca, expect.any(Date));
  });

  // -- 2. event → organization ----------------------------------------------

  it('event → organization: the organization type is kept and the event’s facts and edges move onto it', async () => {
    const org = await node('organization', 'Acme');
    const ev = await node('event', 'Acme Summit');
    const person = await node('person', 'Attendee');
    const evFact = await fact(ev, 'Held in Toronto');
    const attended = await edge(person, ev, 'attended');

    const preview = await service.preview(org, ev);
    expect(preview.crossType).toBe(true);
    expect(preview.result.type).toBe('organization');
    const result = await service.apply({ survivorId: org, absorbedId: ev, planToken: preview.planToken, resolutions: {}, actor: null });
    expect(result.node.type).toBe('organization');
    expect(result.contactMerge).toBeNull();
    expect((await factsOf(org)).map(f => f.id)).toEqual([evFact]);
    expect((await liveEdges(org)).find(e => e.id === attended)).toMatchObject({ source_node_id: person, target_node_id: org });
    expect((await nodeRow(ev))!.archived_at).not.toBeNull();
  });

  it('keeps a dropped fact’s edges to other nodes: moved to the kept fact, or dropped as a duplicate', async () => {
    const s = await node('person', 'Outside S');
    const a = await node('person', 'Outside A');
    const x = await node('project', 'Outside X');
    const y = await node('project', 'Outside Y');
    const kept = await fact(s, 'Enjoys sailing');
    const dropped = await fact(a, 'enjoys sailing.');
    // Writers today link a fact only to its entity; the schema allows more, and the cascade
    // on the dropped fact would take these with it.
    const toX = await edge(x, dropped, 'relates_to');
    await edge(kept, y, 'relates_to');
    const toY = await edge(dropped, y, 'relates_to'); // duplicates kept–y once re-pointed

    const preview = await service.preview(s, a);
    await service.apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: {}, actor: null });

    expect(await nodeRow(dropped)).toBeUndefined();
    const moved = await pool.query<{ source_node_id: string; target_node_id: string }>(
      `SELECT source_node_id, target_node_id FROM kg_edges WHERE id = $1`, [toX],
    );
    expect(moved.rows[0]).toEqual({ source_node_id: x, target_node_id: kept });
    expect((await pool.query(`SELECT 1 FROM kg_edges WHERE id = $1`, [toY])).rows).toHaveLength(0);
    expect((await liveEdges(y)).map(e => [e.source_node_id, e.target_node_id])).toEqual([[kept, y]]);
    expect((await factsOf(s)).map(f => f.id)).toEqual([kept]);
  });

  it('accepts upper-case node ids (Postgres returns uuids in lower case)', async () => {
    const org = await node('organization', 'Globex');
    const dup = await node('organization', 'Globex Corp');
    const dupFact = await fact(dup, 'Based in Springfield');

    const preview = await service.preview(org.toUpperCase(), dup.toUpperCase());
    expect(preview.survivor.id).toBe(org);
    expect(preview.absorbed.id).toBe(dup);
    const result = await service.apply({
      survivorId: org.toUpperCase(), absorbedId: dup.toUpperCase(), planToken: preview.planToken, resolutions: {}, actor: null,
    });
    expect(result.survivorId).toBe(org);
    expect((await factsOf(org)).map(f => f.id)).toEqual([dupFact]);
    expect((await nodeRow(dup))!.archived_at).not.toBeNull();
  });

  // -- 3. organization (org contact) → person (contact) ---------------------

  it('organization with an org contact → person with a contact: one person contact with both identities', async () => {
    const person = await node('person', 'Dana Wu', { identitySource: 'contact' });
    const org = await node('organization', 'Dana Wu Consulting');
    const cp = await contact({ displayName: 'Dana Wu', kgNodeId: person });
    const co = await contact({ displayName: 'Dana Wu Consulting', kgNodeId: org, kind: 'organization' });
    await identity(cp, 'email', `dana-${runId}@example.com`);
    await identity(co, 'email', `info-${runId}@danawu.example`);

    const preview = await service.preview(person, org);
    const result = await service.apply({ survivorId: person, absorbedId: org, planToken: preview.planToken, resolutions: {}, actor: null });
    expect(result.contactMerge).toMatchObject({ survivingContactId: cp, mergedContactIds: [co] });
    expect(await contactRow(co)).toBeUndefined();
    expect(await contactRow(cp)).toMatchObject({ kind: 'person', kg_node_id: person });
    expect(await identitiesOf(cp)).toHaveLength(2);
  });

  // -- 4. person (contact) → organization -----------------------------------

  it('person with a contact → organization: the contact is re-pointed and becomes an organization contact', async () => {
    const org = await node('organization', 'Globex');
    const person = await node('person', 'Globex Support', { identitySource: 'contact' });
    const c = await contact({ displayName: 'Globex Support', kgNodeId: person });

    const preview = await service.preview(org, person);
    expect(preview.suggestedDirection.swap).toBe(true); // personhood would be lost
    expect(preview.contactPlan).toMatchObject({ action: 'repoint', repointedContactIds: [c], resultingKind: 'organization' });
    await service.apply({ survivorId: org, absorbedId: person, planToken: preview.planToken, resolutions: {}, actor: null });
    expect(await contactRow(c)).toMatchObject({ kg_node_id: org, kind: 'organization' });
    expect((await nodeRow(org))!.identity_source).toBe('label');
  });

  // -- 5. blockers ----------------------------------------------------------

  it('blocks absorbing the principal’s node', async (ctx) => {
    if (await principalExists()) ctx.skip();
    const s = await node('person', 'Someone');
    const p = await node('person', 'The Principal', { identitySource: 'contact' });
    await contact({ displayName: 'The Principal', kgNodeId: p, kind: 'principal', systemRole: 'principal', tier: 'principal' });
    const preview = await service.preview(s, p);
    expect(preview.blockers.map(b => b.code)).toContain('absorbed_is_principal');
    expect(preview.suggestedDirection.swap).toBe(true);
    await expect(service.apply({ survivorId: s, absorbedId: p, planToken: preview.planToken, resolutions: {}, actor: null }))
      .rejects.toBeInstanceOf(MergeBlockedError);
    expect((await nodeRow(p))!.archived_at).toBeNull();
  });

  it('blocks the agent node', async () => {
    const existing = await pool.query<{ id: string }>(`SELECT id FROM kg_nodes WHERE properties->>'is_agent' = 'true'`);
    const agent = existing.rows[0]?.id ?? await node('person', 'Curia Agent', { properties: { is_agent: 'true' } });
    const s = await node('person', 'Someone Else');
    const preview = await service.preview(s, agent);
    expect(preview.blockers.map(b => b.code)).toContain('agent_node');
    await expect(service.apply({ survivorId: s, absorbedId: agent, planToken: preview.planToken, resolutions: {}, actor: null }))
      .rejects.toBeInstanceOf(MergeBlockedError);
  });

  it('blocks fact nodes', async () => {
    const s = await node('person', 'Has Facts');
    const f = await fact(s, 'A fact');
    const preview = await service.preview(s, f);
    expect(preview.blockers.map(b => b.code)).toContain('fact_node');
    await expect(service.apply({ survivorId: s, absorbedId: f, planToken: preview.planToken, resolutions: {}, actor: null }))
      .rejects.toBeInstanceOf(MergeBlockedError);
  });

  it('blocks an event survivor whose absorbed node has contacts', async () => {
    const ev = await node('event', 'Launch');
    const person = await node('person', 'Launch Person', { identitySource: 'contact' });
    await contact({ displayName: 'Launch Person', kgNodeId: person });
    const preview = await service.preview(ev, person);
    expect(preview.blockers.map(b => b.code)).toContain('absorbed_has_contacts_incompatible_type');
    await expect(service.apply({ survivorId: ev, absorbedId: person, planToken: preview.planToken, resolutions: {}, actor: null }))
      .rejects.toBeInstanceOf(MergeBlockedError);
  });

  it('blocks taking a label that a third node already holds', async () => {
    const org = await node('organization', 'Initech');
    const ev = await node('event', 'Initrode');
    await node('organization', 'Initrode'); // the third node
    const preview = await service.preview(org, ev);
    expect(preview.warnings.map(w => w.code)).toContain('label_collision');
    const err = await service.apply({ survivorId: org, absorbedId: ev, planToken: preview.planToken, resolutions: { label: 'absorbed' }, actor: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeBlockedError);
    expect((err as MergeBlockedError).blockers[0]!.code).toBe('label_collision');
    // Keeping the survivor's label is fine.
    await service.apply({ survivorId: org, absorbedId: ev, planToken: preview.planToken, resolutions: {}, actor: null });
    expect((await nodeRow(ev))!.archived_at).not.toBeNull();
  });

  // -- 6. stale token -------------------------------------------------------

  it('refuses a stale plan token with nothing changed', async () => {
    const s = await node('person', 'Stale S');
    const a = await node('person', 'Stale A');
    const preview = await service.preview(s, a);
    await fact(a, 'Learned after the preview');

    await expect(service.apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: {}, actor: null }))
      .rejects.toBeInstanceOf(StalePreviewError);
    expect((await nodeRow(a))!.archived_at).toBeNull();
    expect(await factsOf(a)).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('re-checks the token under the row locks: a write between the check and BEGIN is refused', async () => {
    const s = await node('person', 'Locked S');
    const a = await node('person', 'Locked A');
    const preview = await service.preview(s, a);

    // The embedder runs after the unlocked token check and before BEGIN — the window a
    // concurrent writer could use. Write to the graph there, as such a writer would.
    const real = EmbeddingService.createForTesting();
    let injected: string | null = null;
    const racingEmbedder: Embedder = {
      profile: real.profile,
      embed: async (text, purpose) => {
        injected = await fact(a, 'Learned while the merge was embedding');
        return real.embed(text, purpose);
      },
    };
    const racing = serviceWith({ embedder: racingEmbedder });

    await expect(racing.apply({
      survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: { label: 'absorbed' }, actor: null,
    })).rejects.toBeInstanceOf(StalePreviewError);
    expect(injected).not.toBeNull();
    // Nothing the merge would write was written.
    expect((await nodeRow(a))!.archived_at).toBeNull();
    expect((await nodeRow(s))!.label).toBe(`Locked S ${runId}`);
    expect((await factsOf(a)).map(f => f.id)).toEqual([injected]);
    expect(await factsOf(s)).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('discards the connection when ROLLBACK itself fails, and writes nothing', async () => {
    const s = await node('person', 'Rollback Fails S');
    const a = await node('person', 'Rollback Fails A');
    const preview = await service.preview(s, a);

    // A pool whose transaction client cannot roll back; the failure that needs the
    // rollback is the same under-lock staleness as above.
    let release: ReturnType<typeof vi.fn> | null = null;
    const brokenPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
        client.query = ((...args: unknown[]) => (args[0] === 'ROLLBACK'
          ? Promise.reject(new Error('kgmerge test: rollback failed'))
          : realQuery(...args))) as typeof client.query;
        const realRelease = client.release.bind(client);
        release = vi.fn((err?: Error | boolean) => realRelease(err));
        client.release = release as typeof client.release;
        return client;
      },
    } as unknown as pg.Pool;
    const real = EmbeddingService.createForTesting();
    const broken = serviceWith({
      pool: brokenPool,
      embedder: {
        profile: real.profile,
        embed: async (text, purpose) => { await fact(a, 'Races the rollback test'); return real.embed(text, purpose); },
      },
    });

    await expect(broken.apply({
      survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: { label: 'absorbed' }, actor: null,
    })).rejects.toBeInstanceOf(StalePreviewError);
    expect(release).not.toBeNull();
    expect(release!).toHaveBeenCalledTimes(1);
    expect(release!.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((await nodeRow(a))!.archived_at).toBeNull();
    expect((await nodeRow(s))!.label).toBe(`Rollback Fails S ${runId}`);
  });

  it('reports a lost audit event as a warning without undoing the merge', async () => {
    const s = await node('person', 'Audit S');
    const a = await node('person', 'Audit A');
    const preview = await service.preview(s, a);
    const failingPublish = vi.fn().mockRejectedValue(new Error('bus down'));
    const result = await serviceWith({ bus: { publish: failingPublish } as unknown as EventBus })
      .apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: {}, actor: null });
    expect(failingPublish).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual(['audit_event_not_recorded']);
    expect((await nodeRow(a))!.archived_at).not.toBeNull();
  });

  it('treats an invalid embedding like a failed embed: merged, old embedding kept, warned', async () => {
    const s = await node('person', 'Embedding S');
    const a = await node('person', 'Embedding A');
    const preview = await service.preview(s, a);
    const { profile } = EmbeddingService.createForTesting();
    const result = await serviceWith({ embedder: { profile, embed: async () => [0.1, Number.NaN, 0.3] } })
      .apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: { label: 'absorbed' }, actor: null });
    expect(result.warnings).toEqual(['embedding_not_refreshed']);
    const survivor = await nodeRow(s);
    expect(survivor!.label).toBe(`Embedding A ${runId}`);
    expect(survivor!.embedding).toBeNull();
    expect(survivor!.embedding_model).toBeNull();
  });

  it('re-embeds a renamed survivor as a document and stamps the vector with its model (ADR-051)', async () => {
    const s = await node('person', 'Stamp S');
    const a = await node('person', 'Stamp A');
    const embedder = EmbeddingService.createForTesting();
    const purposes: string[] = [];
    const recording: Embedder = {
      profile: embedder.profile,
      embed: async (text, purpose) => { purposes.push(purpose); return embedder.embed(text, purpose); },
    };
    const merging = serviceWith({ embedder: recording });
    const preview = await merging.preview(s, a);
    const result = await merging.apply({
      survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: { label: 'absorbed' }, actor: null,
    });
    expect(result.warnings).toEqual([]);
    expect(purposes).toEqual(['document']);
    const survivor = await nodeRow(s);
    const expected = `[${(await embedder.embed(`Stamp A ${runId}`, 'document')).join(',')}]`;
    const { rows } = await pool.query<{ v: string }>(`SELECT $1::vector::text AS v`, [expected]);
    expect(survivor!.embedding).toBe(rows[0]!.v);
    expect(survivor!.embedding_model).toBe(embeddingStamp(embedder.profile));
  });

  it('keeps the old vector and its stamp when the label does not change', async () => {
    const s = await node('person', 'Unrenamed S');
    const a = await node('person', 'Unrenamed A');
    const { rows } = await pool.query<{ v: string }>(`SELECT array_fill(0.5, ARRAY[1536])::vector::text AS v`);
    await pool.query(`UPDATE kg_nodes SET embedding = $1::vector, embedding_model = 'an-older-model' WHERE id = $2`, [rows[0]!.v, s]);
    const preview = await service.preview(s, a);
    await service.apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: {}, actor: null });
    expect(await nodeRow(s)).toMatchObject({ embedding: rows[0]!.v, embedding_model: 'an-older-model' });
  });

  it('folded contacts that disagree where the survivor holds nothing: earliest field wins, deny wins', async () => {
    // Only organization contacts may share a node (idx_contacts_kg_node_unique), so the
    // several-contacts fold is an organization node absorbed into a person.
    const s = await node('person', 'Disagree S', { identitySource: 'contact' });
    const a = await node('organization', 'Disagree A');
    const cs = await contact({ displayName: 'Disagree S', kgNodeId: s });
    const granting = await contact({ displayName: 'Jane D.', kgNodeId: a, kind: 'organization', title: 'CTO' });
    const denying = await contact({ displayName: 'J. Doe', kgNodeId: a, kind: 'organization', title: 'VP Eng' });
    await pool.query(`UPDATE contacts SET created_at = $2 WHERE id = $1`, [granting, T1]);
    await pool.query(`UPDATE contacts SET created_at = $2 WHERE id = $1`, [denying, T2]);
    await pool.query(
      `INSERT INTO contact_auth_overrides (contact_id, permission, granted) VALUES ($1, 'calendar.write', true), ($2, 'calendar.write', false)`,
      [granting, denying],
    );

    const preview = await service.preview(s, a);
    expect(preview.warnings.find(w => w.code === 'contacts_disagree')!.details).toEqual([
      "Title: 'CTO' (Jane D.) kept over 'VP Eng' (J. Doe)",
      'calendar.write: denied kept over granted',
    ]);
    await service.apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: {}, actor: null });

    expect(await contactRow(cs)).toMatchObject({ title: 'CTO' });
    const active = await pool.query<{ permission: string; granted: boolean }>(
      `SELECT permission, granted FROM contact_auth_overrides WHERE contact_id = $1 AND revoked_at IS NULL`,
      [cs],
    );
    expect(active.rows).toEqual([{ permission: 'calendar.write', granted: false }]);
  });

  it('contactless person survivor: a peer’s deny beats the promoted contact’s own grant (QA A)', async () => {
    // The survivor node has no contact, so the earliest absorbed contact is promoted onto
    // it. Its grant is a peer's value, not the survivor's: the later contact's deny wins.
    const s = await node('person', 'Peer S');
    const a = await node('organization', 'Peer A');
    const granting = await contact({ displayName: 'Peer Granting', kgNodeId: a, kind: 'organization', title: 'CTO' });
    const denying = await contact({ displayName: 'Peer Denying', kgNodeId: a, kind: 'organization', title: 'VP Eng' });
    await pool.query(`UPDATE contacts SET created_at = $2 WHERE id = $1`, [granting, T1]);
    await pool.query(`UPDATE contacts SET created_at = $2 WHERE id = $1`, [denying, T2]);
    await pool.query(
      `INSERT INTO contact_auth_overrides (contact_id, permission, granted) VALUES ($1, 'calendar.write', true), ($2, 'calendar.write', false)`,
      [granting, denying],
    );

    const preview = await service.preview(s, a);
    expect(preview.contactPlan).toMatchObject({ survivingContactId: granting, mergedContactIds: [denying] });
    expect(preview.conflicts.authOverrides).toEqual([]);
    expect(preview.conflicts.contactFields).toEqual([]);
    expect(preview.warnings.find(w => w.code === 'contacts_disagree')!.details).toEqual([
      "Title: 'CTO' (Peer Granting) kept over 'VP Eng' (Peer Denying)",
      'calendar.write: denied kept over granted',
    ]);
    await service.apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: {}, actor: null });

    expect(await contactRow(granting)).toMatchObject({ kg_node_id: s, kind: 'person', title: 'CTO' });
    expect(await contactRow(denying)).toBeUndefined();
    const active = await pool.query<{ permission: string; granted: boolean }>(
      `SELECT permission, granted FROM contact_auth_overrides WHERE contact_id = $1 AND revoked_at IS NULL`,
      [granting],
    );
    expect(active.rows).toEqual([{ permission: 'calendar.write', granted: false }]);
  });

  // -- 7. failure mid-transaction -------------------------------------------

  it('rolls back everything when a statement fails mid-transaction', async () => {
    // A trigger that fails the absorbed node's archive — the step after the contacts,
    // facts and edges have all been written inside the transaction. Scoped by label
    // prefix so it can never fire for another suite's rows.
    await pool.query(`
      CREATE OR REPLACE FUNCTION kgmerge_test_inject_failure() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'kgmerge test: injected failure'; END $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS kgmerge_test_inject_failure ON kg_nodes`);
    await pool.query(`
      CREATE TRIGGER kgmerge_test_inject_failure BEFORE UPDATE ON kg_nodes FOR EACH ROW
      WHEN (OLD.label LIKE 'kgmerge-fail-inject %' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
      EXECUTE FUNCTION kgmerge_test_inject_failure()`);
    try {
      const s = await node('person', 'Rollback S', { identitySource: 'contact' });
      const a = await node('person', 'kgmerge-fail-inject', { identitySource: 'contact' });
      const cs = await contact({ displayName: 'Rollback S', kgNodeId: s });
      const ca = await contact({ displayName: 'Rollback A', kgNodeId: a });
      await identity(ca, 'email', `rollback-${runId}@example.com`);
      const aFact = await fact(a, 'Moves only on success');
      const x = await node('project', 'Rollback Project');
      const aEdge = await edge(a, x, 'works_on');

      const preview = await service.preview(s, a);
      await expect(service.apply({ survivorId: s, absorbedId: a, planToken: preview.planToken, resolutions: {}, actor: null }))
        .rejects.toThrow(/injected failure/);

      expect(await contactRow(ca)).toMatchObject({ kg_node_id: a });
      expect(await contactRow(cs)).toMatchObject({ kg_node_id: s });
      expect(await identitiesOf(ca)).toHaveLength(1);
      expect((await factsOf(a)).map(f => f.id)).toEqual([aFact]);
      expect((await liveEdges(a)).map(e => e.id)).toContain(aEdge);
      expect((await nodeRow(a))!.archived_at).toBeNull();
      expect(publish).not.toHaveBeenCalled();
      expect(onContactMerged).not.toHaveBeenCalled();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS kgmerge_test_inject_failure ON kg_nodes`);
      await pool.query(`DROP FUNCTION IF EXISTS kgmerge_test_inject_failure()`);
    }
  });

  // -- merge candidates -----------------------------------------------------

  it('suggests live non-fact nodes of any type by label, alias and embedding', async () => {
    const embedder = EmbeddingService.createForTesting();
    const vector = `[${(await embedder.embed(`acme-${runId}`, 'document')).join(',')}]`;
    const stamp = embeddingStamp(embedder.profile);

    const base = await node('organization', 'Acme Corp');
    const sameLabel = await node('event', 'ACME CORP');
    const aliasHolder = await node('person', 'Acme Contact', { aliases: [`acme corp ${runId}`] });
    const similar = await node('project', 'Unrelated name');
    // The same vector from another model is not comparable, however close it scores.
    const otherModel = await node('project', 'Another model entirely');
    const archived = await node('concept', 'acme corp');
    await pool.query(`UPDATE kg_nodes SET archived_at = now() WHERE id = $1`, [archived]);
    await fact(base, `Acme Corp ${runId}`); // a fact with the same text is never a candidate
    await pool.query(`UPDATE kg_nodes SET embedding = $1::vector, embedding_model = $2 WHERE id = ANY($3::uuid[])`, [vector, stamp, [base, similar]]);
    await pool.query(`UPDATE kg_nodes SET embedding = $1::vector, embedding_model = 'another-model' WHERE id = $2`, [vector, otherModel]);

    const candidates = await service.candidates(base, 8);
    const byId = new Map(candidates.map(c => [c.node.id, c]));
    expect(byId.get(sameLabel)).toMatchObject({ score: 1, reasons: ['same_label'] });
    expect(byId.get(aliasHolder)).toMatchObject({ score: 1, reasons: ['alias_match'] });
    expect(byId.get(similar)).toMatchObject({ reasons: ['similar_embedding'] });
    expect(byId.get(similar)!.score).toBeGreaterThanOrEqual(embedder.profile.thresholds.fuzzyAmbiguityFloor);
    expect(byId.has(otherModel)).toBe(false);
    expect(byId.has(archived)).toBe(false);
    expect(byId.has(base)).toBe(false);
    expect(candidates.every(c => c.node.type !== 'fact')).toBe(true);
    expect(byId.get(sameLabel)!.node).toMatchObject({ type: 'event', identitySource: 'label', aliases: [] });

    // Without an embedder (the knowledge graph's embedding gate is closed) no score is trusted.
    const unscored = await serviceWith({ embedder: undefined }).candidates(base, 8);
    expect(unscored.some(c => c.reasons.includes('similar_embedding'))).toBe(false);
    expect(unscored.map(c => c.node.id)).toContain(sameLabel);
  });

  // -- 8. principal survivor ------------------------------------------------

  it('requires an acknowledgement before identities become principal identities', async (ctx) => {
    if (await principalExists()) ctx.skip();
    const p = await node('person', 'Principal Self', { identitySource: 'contact' });
    const dup = await node('person', 'Principal Duplicate', { identitySource: 'contact' });
    const cp = await contact({ displayName: 'Principal Self', kgNodeId: p, kind: 'principal', systemRole: 'principal', tier: 'principal' });
    const cd = await contact({ displayName: 'Principal Duplicate', kgNodeId: dup, tier: 'blocked' });
    const sms = `+1666${Date.now() % 10_000_000}`;
    await identity(cd, 'sms', sms, false);
    // The principal has no primary email, so the fold fills it — a trust-relevant change (QA G).
    const dupEmail = `principal-dup-${runId}@example.com`;
    await pool.query(`UPDATE contacts SET primary_email = $2 WHERE id = $1`, [cd, dupEmail]);
    const principalEmail = await pool.query<{ primary_email: string | null }>(`SELECT primary_email FROM contacts WHERE id = $1`, [cp]);
    expect(principalEmail.rows[0]!.primary_email).toBeNull();

    const preview = await service.preview(p, dup);
    const warning = preview.warnings.find(w => w.code === 'principal_identity_transfer');
    expect(warning).toMatchObject({ requiresAck: true });
    expect(warning!.details).toEqual([`sms: ${sms}`, `Primary email will become ${dupEmail}`]);

    const err = await service.apply({ survivorId: p, absorbedId: dup, planToken: preview.planToken, resolutions: {}, actor: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidResolutionError);
    expect((err as InvalidResolutionError).code).toBe('ack_required');
    expect(await contactRow(cd)).toBeDefined();

    await service.apply({
      survivorId: p,
      absorbedId: dup,
      planToken: preview.planToken,
      resolutions: { label: 'absorbed', acknowledgements: ['principal_identity_transfer'] },
      actor: null,
    });
    expect(await contactRow(cd)).toBeUndefined();
    // Structural survivor: keeps its name, kind and tier (a blocked duplicate cannot lock it out).
    expect(await contactRow(cp)).toMatchObject({ display_name: 'Principal Self', kind: 'principal', tier: 'principal' });
    expect(await identitiesOf(cp)).toHaveLength(1);
    // The audit event records what principal-level trust the merge handed over (QA G).
    const event = publish.mock.calls.at(-1)![1] as Extract<BusEvent, { type: 'kg.nodes_merged' }>;
    expect(event.payload.principalIdentitiesTransferred).toEqual([`sms: ${sms}`]);
    expect(event.payload.principalPrimaryFieldsFilled).toEqual({ primary_email: dupEmail });
    // The label changed, so the survivor was re-embedded before the transaction.
    const survivor = await nodeRow(p);
    expect(survivor!.label).toBe(`Principal Duplicate ${runId}`);
    expect(survivor!.embedding).not.toBeNull();
    expect(survivor!.embedding_model).toBe(embeddingStamp(EmbeddingService.createForTesting().profile));
  });
});
