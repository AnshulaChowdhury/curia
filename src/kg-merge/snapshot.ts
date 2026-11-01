// snapshot.ts — load everything the merge planner reads, in one consistent shape.
//
// Spec: docs/wip/2026-10-21-kg-node-merge-design.md §7. Called twice per apply: once on
// the pool without locks (fast stale check), then on the transaction's client with
// `forUpdate`, which locks both nodes (ordered by id, so two merges touching the same
// nodes queue instead of deadlocking), every linked contact, every live edge on the two
// nodes, then every linked fact node and the facts' outside edges. FOR UPDATE on the node
// rows blocks concurrent edge inserts against them (the FK check takes KEY SHARE); the edge
// locks block a concurrent update, such as a reinforcement, that the executor's collapse
// values would otherwise overwrite.
//
// Every array is sorted deterministically: the plan token hashes this object.

import type { DbPool, DbPoolClient } from '../db/connection.js';
import type { DecayClass, IdentitySource, NodeType, Sensitivity } from '../memory/types.js';
import type { ContactKind, ContactTier, SystemRole } from '../contacts/types.js';
import { NodeNotFoundError } from './errors.js';
import type {
  ApiKgNode,
  ContactMergeField,
  MergeSide,
  MergeSnapshot,
  SnapshotAuthOverride,
  SnapshotContact,
  SnapshotEdge,
  SnapshotFact,
  SnapshotIdentity,
  SnapshotNode,
} from './types.js';

export type Queryable = DbPool | DbPoolClient;

export interface PgNodeRow {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  embedding: string | null;
  embedding_model: string | null;
  confidence: number;
  decay_class: string;
  source: string;
  sensitivity: string;
  created_at: Date;
  last_confirmed_at: Date;
  archived_at: Date | null;
  warned_at: Date | null;
  warn_reason: string | null;
  aliases: string[] | null;
  identity_source: string;
}

interface PgEdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  decay_class: string;
  source: string;
  created_at: Date;
  last_confirmed_at: Date;
}

interface PgSideEdgeRow extends PgEdgeRow {
  other_type: string;
  other_archived: boolean;
}

interface PgContactRow {
  id: string;
  kg_node_id: string;
  display_name: string;
  role: string | null;
  system_role: string | null;
  tier: string;
  kind: string;
  notes: string | null;
  contact_confidence: string;
  last_seen_at: Date | null;
  inbound_message_count: number;
  outbound_message_count: number;
  preferred_name: string | null;
  title: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedin_url: string | null;
  bio: string | null;
  birthday: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Node columns, with the vector as text so it parses without a pgvector type parser. */
export const NODE_COLUMNS = `id, type, label, properties, embedding::text AS embedding, embedding_model, confidence,
  decay_class, source, sensitivity, created_at, last_confirmed_at, archived_at, warned_at, warn_reason, aliases, identity_source`;

const NODES_SQL = `SELECT ${NODE_COLUMNS} FROM kg_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`;
const NODES_FOR_UPDATE_SQL = `${NODES_SQL} FOR UPDATE`;

const CONTACT_COLUMNS = `id, kg_node_id, display_name, role, system_role, tier, kind, notes, contact_confidence,
  last_seen_at, inbound_message_count, outbound_message_count, preferred_name, title, organization,
  primary_email, primary_phone, timezone, locale, location, pronouns, linkedin_url, bio, birthday,
  created_at, updated_at`;
const CONTACTS_SQL = `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE kg_node_id = ANY($1::uuid[]) ORDER BY created_at, id`;
const CONTACTS_FOR_UPDATE_SQL = `${CONTACTS_SQL} FOR UPDATE`;

// Every live edge touching $1, with the type of the node at the other end so fact links
// can be told apart from entity relationships.
const EDGES_SQL = `
  SELECT e.id, e.source_node_id, e.target_node_id, e.type, e.properties, e.confidence, e.decay_class,
         e.source, e.created_at, e.last_confirmed_at,
         o.type AS other_type, (o.archived_at IS NOT NULL) AS other_archived
  FROM kg_edges e
  JOIN kg_nodes o
    ON o.id = CASE WHEN e.source_node_id = $1::uuid THEN e.target_node_id ELSE e.source_node_id END
  WHERE e.archived_at IS NULL
    AND (e.source_node_id = $1::uuid OR e.target_node_id = $1::uuid)
  ORDER BY e.id`;
// OF e: lock the edges only; the joined node rows are read for their type.
const EDGES_FOR_UPDATE_SQL = `${EDGES_SQL} FOR UPDATE OF e`;

// Live edges from the given facts to anything but the two merge nodes (SnapshotFact.outsideEdges).
// Locked with the facts in the locked pass, so the set cannot change before the executor runs.
const FACT_OUTSIDE_EDGES_SQL = `
  SELECT id, source_node_id, target_node_id, type, properties, confidence, decay_class,
         source, created_at, last_confirmed_at
  FROM kg_edges
  WHERE archived_at IS NULL
    AND (source_node_id = ANY($1::uuid[]) OR target_node_id = ANY($1::uuid[]))
    AND source_node_id <> ALL($2::uuid[]) AND target_node_id <> ALL($2::uuid[])
  ORDER BY id`;
const FACT_OUTSIDE_EDGES_FOR_UPDATE_SQL = `${FACT_OUTSIDE_EDGES_SQL} FOR UPDATE`;

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Parse pgvector text "[0.1,0.2]" into numbers. */
export function parseVector(text: string): number[] {
  const values = text.replace(/^\[/, '').replace(/\]$/, '').split(',').map(Number);
  if (values.some(Number.isNaN)) {
    throw new Error('kg-merge: malformed pgvector string (NaN component)');
  }
  return values;
}

export function rowToSnapshotNode(row: PgNodeRow): SnapshotNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    label: row.label,
    properties: row.properties ?? {},
    embedding: row.embedding ? parseVector(row.embedding) : null,
    embeddingModel: row.embedding_model,
    confidence: row.confidence,
    decayClass: row.decay_class as DecayClass,
    source: row.source,
    sensitivity: row.sensitivity as Sensitivity,
    createdAt: iso(row.created_at),
    lastConfirmedAt: iso(row.last_confirmed_at),
    archivedAt: isoOrNull(row.archived_at),
    warnedAt: isoOrNull(row.warned_at),
    warnReason: row.warn_reason,
    aliases: row.aliases ?? [],
    identitySource: (row.identity_source === 'contact' ? 'contact' : 'label') as IdentitySource,
  };
}

/** The node shape GET /api/kg/nodes returns. */
export function toApiKgNode(row: PgNodeRow): ApiKgNode {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    properties: row.properties ?? {},
    confidence: row.confidence,
    decayClass: row.decay_class,
    source: row.source,
    createdAt: iso(row.created_at),
    lastConfirmedAt: iso(row.last_confirmed_at),
    sensitivity: row.sensitivity,
    aliases: row.aliases ?? [],
    identitySource: row.identity_source === 'contact' ? 'contact' : 'label',
  };
}

function rowToEdge(row: PgEdgeRow): SnapshotEdge {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    type: row.type,
    properties: row.properties ?? {},
    confidence: row.confidence,
    decayClass: row.decay_class as DecayClass,
    source: row.source,
    createdAt: iso(row.created_at),
    lastConfirmedAt: iso(row.last_confirmed_at),
  };
}

function rowToContact(
  row: PgContactRow,
  identities: SnapshotIdentity[],
  authOverrides: SnapshotAuthOverride[],
): SnapshotContact {
  const confidence = Number.parseFloat(row.contact_confidence);
  const fields: Record<ContactMergeField, string | null> = {
    role: row.role,
    preferred_name: row.preferred_name,
    title: row.title,
    organization: row.organization,
    primary_email: row.primary_email,
    primary_phone: row.primary_phone,
    timezone: row.timezone,
    locale: row.locale,
    location: row.location,
    pronouns: row.pronouns,
    linkedin_url: row.linkedin_url,
    bio: row.bio,
    birthday: row.birthday,
  };
  return {
    id: row.id,
    kgNodeId: row.kg_node_id,
    displayName: row.display_name,
    systemRole: (row.system_role as SystemRole | null) ?? null,
    // CHECK constraints bound both columns to the union members.
    tier: row.tier as ContactTier,
    kind: row.kind as ContactKind,
    notes: row.notes,
    fields,
    contactConfidence: Number.isFinite(confidence) ? confidence : 0,
    lastSeenAt: isoOrNull(row.last_seen_at),
    inboundMessageCount: row.inbound_message_count,
    outboundMessageCount: row.outbound_message_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    identities,
    authOverrides,
  };
}

async function loadSide(
  q: Queryable,
  node: SnapshotNode,
  contacts: SnapshotContact[],
  forUpdate: boolean,
): Promise<{ side: Omit<MergeSide, 'facts'>; factLinks: Map<string, string[]> }> {
  const { rows } = await q.query<PgSideEdgeRow>(forUpdate ? EDGES_FOR_UPDATE_SQL : EDGES_SQL, [node.id]);
  const edges: SnapshotEdge[] = [];
  const factLinks = new Map<string, string[]>();
  for (const row of rows) {
    const otherId = row.source_node_id === node.id ? row.target_node_id : row.source_node_id;
    if (row.type === 'relates_to' && row.other_type === 'fact' && !row.other_archived && otherId !== node.id) {
      factLinks.set(otherId, [...(factLinks.get(otherId) ?? []), row.id]);
    } else {
      edges.push(rowToEdge(row));
    }
  }
  return { side: { node, edges, contacts }, factLinks };
}

/**
 * Load the merge snapshot. Throws NodeNotFoundError when either node is missing or
 * archived. Does not reject fact nodes — the planner turns that into a blocker.
 */
export async function loadMergeSnapshot(
  q: Queryable,
  survivorId: string,
  absorbedId: string,
  options: { forUpdate: boolean },
): Promise<MergeSnapshot> {
  const nodeRows = await q.query<PgNodeRow>(options.forUpdate ? NODES_FOR_UPDATE_SQL : NODES_SQL, [[survivorId, absorbedId]]);
  const byId = new Map(nodeRows.rows.map(r => [r.id, r]));
  for (const id of [survivorId, absorbedId]) {
    const row = byId.get(id);
    if (!row || row.archived_at !== null) throw new NodeNotFoundError(id);
  }
  const survivorNode = rowToSnapshotNode(byId.get(survivorId)!);
  const absorbedNode = rowToSnapshotNode(byId.get(absorbedId)!);

  // Contacts (locked when forUpdate), with identities and active overrides.
  const contactRows = await q.query<PgContactRow>(
    options.forUpdate ? CONTACTS_FOR_UPDATE_SQL : CONTACTS_SQL,
    [[survivorId, absorbedId]],
  );
  const contactIds = contactRows.rows.map(r => r.id);
  const identitiesByContact = new Map<string, SnapshotIdentity[]>();
  const overridesByContact = new Map<string, SnapshotAuthOverride[]>();
  if (contactIds.length > 0) {
    const identityRows = await q.query<{ id: string; contact_id: string; channel: string; channel_identifier: string; verified: boolean }>(
      `SELECT id, contact_id, channel, channel_identifier, verified
       FROM contact_channel_identities WHERE contact_id = ANY($1::uuid[]) ORDER BY id`,
      [contactIds],
    );
    for (const r of identityRows.rows) {
      const list = identitiesByContact.get(r.contact_id) ?? [];
      list.push({ id: r.id, channel: r.channel, identifier: r.channel_identifier, verified: r.verified });
      identitiesByContact.set(r.contact_id, list);
    }
    const overrideRows = await q.query<{ contact_id: string; permission: string; granted: boolean }>(
      `SELECT contact_id, permission, granted
       FROM contact_auth_overrides
       WHERE contact_id = ANY($1::uuid[]) AND revoked_at IS NULL
       ORDER BY permission`,
      [contactIds],
    );
    for (const r of overrideRows.rows) {
      const list = overridesByContact.get(r.contact_id) ?? [];
      list.push({ permission: r.permission, granted: r.granted });
      overridesByContact.set(r.contact_id, list);
    }
  }
  const contacts = contactRows.rows.map(r =>
    rowToContact(r, identitiesByContact.get(r.id) ?? [], overridesByContact.get(r.id) ?? []),
  );

  const survivorSide = await loadSide(q, survivorNode, contacts.filter(c => c.kgNodeId === survivorId), options.forUpdate);
  const absorbedSide = await loadSide(q, absorbedNode, contacts.filter(c => c.kgNodeId === absorbedId), options.forUpdate);

  // Fact nodes for both sides in one query.
  const factIds = [...new Set([...survivorSide.factLinks.keys(), ...absorbedSide.factLinks.keys()])];
  const factNodes = new Map<string, SnapshotNode>();
  if (factIds.length > 0) {
    // Under forUpdate the fact rows are locked too — after the entity nodes and contacts,
    // ordered by id like every other lock here — so a concurrent fact edit cannot slip in
    // between the token check and the executor's fact updates and deletes.
    const factRows = await q.query<PgNodeRow>(options.forUpdate ? NODES_FOR_UPDATE_SQL : NODES_SQL, [factIds]);
    for (const r of factRows.rows) factNodes.set(r.id, rowToSnapshotNode(r));
  }
  const outsideEdges: SnapshotEdge[] = factIds.length === 0 ? [] : (await q.query<PgEdgeRow>(
    options.forUpdate ? FACT_OUTSIDE_EDGES_FOR_UPDATE_SQL : FACT_OUTSIDE_EDGES_SQL,
    [factIds, [survivorId, absorbedId]],
  )).rows.map(rowToEdge);
  const outsideOf = (factId: string): SnapshotEdge[] =>
    outsideEdges.filter(e => e.sourceNodeId === factId || e.targetNodeId === factId);
  const toFacts = (links: Map<string, string[]>): SnapshotFact[] =>
    [...links.entries()]
      .filter(([id]) => factNodes.has(id))
      .map(([id, linkEdgeIds]) => ({ node: factNodes.get(id)!, linkEdgeIds: [...linkEdgeIds].sort(), outsideEdges: outsideOf(id) }))
      .sort((x, y) => x.node.id.localeCompare(y.node.id));

  // Would the absorbed label collide with a third node if chosen? Only label-tier live
  // nodes of the survivor's type are in idx_kg_nodes_unique.
  const owner = await q.query<{ id: string; label: string; type: string }>(
    `SELECT id, label, type FROM kg_nodes
     WHERE lower(label) = lower($1) AND type = $2 AND identity_source = 'label'
       AND archived_at IS NULL AND type <> 'fact' AND id <> ALL($3::uuid[])
     ORDER BY id LIMIT 1`,
    [absorbedNode.label, survivorNode.type, [survivorId, absorbedId]],
  );

  return {
    survivor: { ...survivorSide.side, facts: toFacts(survivorSide.factLinks) },
    absorbed: { ...absorbedSide.side, facts: toFacts(absorbedSide.factLinks) },
    absorbedLabelOwner: owner.rows[0] ? { id: owner.rows[0].id, label: owner.rows[0].label, type: owner.rows[0].type } : null,
  };
}
