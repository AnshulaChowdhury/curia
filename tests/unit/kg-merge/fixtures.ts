// Snapshot builders for the pure kg-merge planner/resolve tests.
import type {
  ContactMergeField,
  MergeSide,
  MergeSnapshot,
  SnapshotContact,
  SnapshotEdge,
  SnapshotFact,
  SnapshotNode,
} from '../../../src/kg-merge/types.js';
import { CONTACT_MERGE_FIELDS } from '../../../src/kg-merge/types.js';
import type { FactSimilarity } from '../../../src/kg-merge/planner.js';

/** Deterministic UUID-shaped id from a number. */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const S_ID = uid(1);
export const A_ID = uid(2);

/** The stamp makeNode gives a node that has an embedding, and the model FACT_SIMILARITY scores. */
export const TEST_EMBEDDING_MODEL = 'test-embedding-model';
export const FACT_SIMILARITY: FactSimilarity = { embeddingModel: TEST_EMBEDDING_MODEL, threshold: 0.92 };

export function makeNode(overrides: Partial<SnapshotNode> & { id: string }): SnapshotNode {
  return {
    type: 'person',
    label: 'Node',
    properties: {},
    embedding: null,
    embeddingModel: overrides.embedding ? TEST_EMBEDDING_MODEL : null,
    confidence: 0.7,
    decayClass: 'slow_decay',
    source: 'test',
    sensitivity: 'internal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastConfirmedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    warnedAt: null,
    warnReason: null,
    aliases: [],
    identitySource: 'label',
    ...overrides,
  };
}

export function makeFact(
  id: string,
  label: string,
  properties: Record<string, unknown> = {},
  overrides: Partial<SnapshotNode> = {},
  linkEdgeIds: string[] = [`link-${id}`],
): SnapshotFact {
  return { node: makeNode({ id, type: 'fact', label, properties, ...overrides }), linkEdgeIds };
}

export function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  type = 'works_on',
  overrides: Partial<SnapshotEdge> = {},
): SnapshotEdge {
  return {
    id,
    sourceNodeId,
    targetNodeId,
    type,
    properties: {},
    confidence: 0.7,
    decayClass: 'slow_decay',
    source: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastConfirmedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeContact(
  overrides: Partial<Omit<SnapshotContact, 'fields'>> & { id: string; kgNodeId: string; fields?: Partial<Record<ContactMergeField, string | null>> },
): SnapshotContact {
  const fields = Object.fromEntries(CONTACT_MERGE_FIELDS.map(f => [f, null])) as Record<ContactMergeField, string | null>;
  const { fields: fieldOverrides, ...rest } = overrides;
  return {
    displayName: 'Contact',
    systemRole: null,
    tier: 'known',
    kind: 'person',
    notes: null,
    contactConfidence: 0.5,
    lastSeenAt: null,
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    identities: [],
    authOverrides: [],
    ...rest,
    fields: { ...fields, ...fieldOverrides },
  };
}

export function makeSide(
  node: SnapshotNode,
  parts: Partial<Omit<MergeSide, 'node'>> = {},
): MergeSide {
  return { node, facts: parts.facts ?? [], edges: parts.edges ?? [], contacts: parts.contacts ?? [] };
}

/**
 * `absorbedLabelOwnerId` names a third node already holding the absorbed label; it gets
 * that label (as stored, in its own case) and the survivor's type, as the snapshot query does.
 */
export function makeSnapshot(
  survivor: MergeSide,
  absorbed: MergeSide,
  absorbedLabelOwnerId: string | null = null,
  ownerLabel: string = absorbed.node.label,
): MergeSnapshot {
  return {
    survivor,
    absorbed,
    absorbedLabelOwner: absorbedLabelOwnerId
      ? { id: absorbedLabelOwnerId, label: ownerLabel, type: survivor.node.type }
      : null,
  };
}

/** Two plain person nodes with no contacts, facts or edges. */
export function basicPair(
  s: Partial<SnapshotNode> = {},
  a: Partial<SnapshotNode> = {},
): { survivor: SnapshotNode; absorbed: SnapshotNode } {
  return {
    survivor: makeNode({ id: S_ID, label: 'Jane Doe', ...s }),
    absorbed: makeNode({ id: A_ID, label: 'J. Doe', ...a }),
  };
}
