// types.ts — knowledge-graph node merge: snapshot, plan, resolutions, preview and result.
//
// Spec: docs/wip/2026-10-21-kg-node-merge-design.md. The preview/result/resolution shapes
// (§8) are the HTTP contract; apps/console/src/pages/kg-merge-types.ts mirrors them, so a
// change here is a change to the console contract too.

import type { DecayClass, IdentitySource, NodeType, Sensitivity } from '../memory/types.js';
import type { ContactKind, ContactTier, SystemRole } from '../contacts/types.js';
import type { MergedContactRow } from '../contacts/contact-service.js';

// ---------------------------------------------------------------------------
// Resolutions (request body)
// ---------------------------------------------------------------------------

export type Side = 'survivor' | 'absorbed';
export type FactChoice = Side | 'both';
export type NearDuplicateChoice = 'merge' | 'keep_both';

export interface NodeMergeResolutions {
  label?: Side;
  /** property key → side */
  properties?: Record<string, Side>;
  /** fact-conflict id → choice */
  facts?: Record<string, FactChoice>;
  /** near-duplicate id → choice */
  nearDuplicateFacts?: Record<string, NearDuplicateChoice>;
  /** contact field name (snake_case column) → side */
  contactFields?: Record<string, Side>;
  /** permission → side */
  authOverrides?: Record<string, Side>;
  /** warning codes the user acknowledged */
  acknowledgements?: string[];
}

// ---------------------------------------------------------------------------
// Snapshot — everything the planner reads, loaded by snapshot.ts
// ---------------------------------------------------------------------------

export interface SnapshotNode {
  id: string;
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  embedding: number[] | null;
  confidence: number;
  decayClass: DecayClass;
  source: string;
  sensitivity: Sensitivity;
  createdAt: string;
  lastConfirmedAt: string;
  archivedAt: string | null;
  warnedAt: string | null;
  warnReason: string | null;
  aliases: string[];
  identitySource: IdentitySource;
}

export interface SnapshotEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  decayClass: DecayClass;
  source: string;
  createdAt: string;
  lastConfirmedAt: string;
}

/** A fact node attached to one side, with the edges that attach it to that side. */
export interface SnapshotFact {
  node: SnapshotNode;
  linkEdgeIds: string[];
}

export interface SnapshotIdentity {
  id: string;
  channel: string;
  identifier: string;
  verified: boolean;
}

export interface SnapshotAuthOverride {
  permission: string;
  granted: boolean;
}

/** Contact columns that take part in field-conflict detection (§5.1), snake_case. */
export const CONTACT_MERGE_FIELDS = [
  'role',
  'preferred_name',
  'title',
  'organization',
  'primary_email',
  'primary_phone',
  'timezone',
  'locale',
  'location',
  'pronouns',
  'linkedin_url',
  'bio',
  'birthday',
] as const;
export type ContactMergeField = (typeof CONTACT_MERGE_FIELDS)[number];

export const CONTACT_MERGE_FIELD_LABELS: Record<ContactMergeField, string> = {
  role: 'Role',
  preferred_name: 'Preferred name',
  title: 'Title',
  organization: 'Organization',
  primary_email: 'Primary email',
  primary_phone: 'Primary phone',
  timezone: 'Timezone',
  locale: 'Locale',
  location: 'Location',
  pronouns: 'Pronouns',
  linkedin_url: 'LinkedIn',
  bio: 'Bio',
  birthday: 'Birthday',
};

export interface SnapshotContact {
  id: string;
  kgNodeId: string;
  displayName: string;
  systemRole: SystemRole | null;
  tier: ContactTier;
  kind: ContactKind;
  notes: string | null;
  fields: Record<ContactMergeField, string | null>;
  contactConfidence: number;
  lastSeenAt: string | null;
  inboundMessageCount: number;
  outboundMessageCount: number;
  createdAt: string;
  updatedAt: string;
  identities: SnapshotIdentity[];
  authOverrides: SnapshotAuthOverride[];
}

export interface MergeSide {
  node: SnapshotNode;
  /** Live fact nodes linked to this node by a relates_to edge (either direction), by id. */
  facts: SnapshotFact[];
  /** Every other live edge touching this node, by id (includes edges to the other side). */
  edges: SnapshotEdge[];
  /** Contacts whose kg_node_id is this node, by created_at then id. */
  contacts: SnapshotContact[];
}

export interface MergeSnapshot {
  survivor: MergeSide;
  absorbed: MergeSide;
  /**
   * A third live label-tier node already holding (lower(absorbed label), survivor type),
   * or null. Choosing the absorbed label would collide with it on idx_kg_nodes_unique.
   */
  absorbedLabelOwnerId: string | null;
}

// ---------------------------------------------------------------------------
// Preview / result (HTTP response bodies, §8)
// ---------------------------------------------------------------------------

export interface ApiKgNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  confidence: number;
  decayClass: string;
  source: string;
  createdAt: string;
  lastConfirmedAt: string;
  sensitivity: string;
  aliases: string[];
  identitySource: IdentitySource;
}

export interface MergeNodeSummary {
  id: string;
  label: string;
  type: string;
  aliases: string[];
  identitySource: IdentitySource;
  sensitivity: string;
  confidence: number;
  decayClass: string;
  lastConfirmedAt: string;
  factCount: number;
  edgeCount: number;
  contacts: {
    id: string;
    displayName: string;
    kind: string | null;
    systemRole: string | null;
    tier: string;
    identityCount: number;
  }[];
}

export interface MergeFactSummary {
  id: string;
  label: string;
  attribute: string | null;
  value: string | null;
  confidence: number;
  lastConfirmedAt: string;
  source: string;
  sensitivity: string;
}

export interface MergeBlocker {
  code: string;
  message: string;
}

export interface MergeWarning {
  code: string;
  message: string;
  requiresAck: boolean;
  details?: string[];
}

export interface MergeSummaryCounts {
  factsMoved: number;
  factsCollapsed: number;
  edgesMoved: number;
  edgesCollapsed: number;
  edgesDropped: number;
}

export interface PropertyConflict {
  key: string;
  survivorValue: unknown;
  absorbedValue: unknown;
  default: Side;
}

export interface FactConflictView {
  id: string;
  attribute: string;
  survivor: MergeFactSummary;
  absorbed: MergeFactSummary;
  default: FactChoice;
}

export interface NearDuplicateView {
  id: string;
  survivor: MergeFactSummary;
  absorbed: MergeFactSummary;
  similarity: number;
  default: NearDuplicateChoice;
}

export interface ContactFieldConflict {
  field: string;
  label: string;
  survivorValue: string | null;
  absorbedValue: string | null;
  default: Side;
}

export interface AuthOverrideConflict {
  permission: string;
  survivorGranted: boolean;
  absorbedGranted: boolean;
  default: Side;
}

export interface ContactPlanView {
  action: 'none' | 'merge' | 'repoint';
  survivingContactId: string | null;
  mergedContactIds: string[];
  repointedContactIds: string[];
  resultingKind: string | null;
  identities: { channel: string; identifier: string; from: Side; duplicate: boolean; verified: boolean }[];
}

export interface NodeMergePreview {
  dryRun: true;
  planToken: string;
  survivor: MergeNodeSummary;
  absorbed: MergeNodeSummary;
  crossType: boolean;
  suggestedDirection: { swap: boolean; reason: string | null };
  result: {
    type: string;
    labels: { survivor: string; absorbed: string };
    defaultLabel: Side;
    aliases: string[];
    droppedAliases: string[];
    sensitivity: string;
    confidence: number;
    decayClass: string;
    identitySource: IdentitySource;
  };
  blockers: MergeBlocker[];
  warnings: MergeWarning[];
  conflicts: {
    properties: PropertyConflict[];
    facts: FactConflictView[];
    nearDuplicateFacts: NearDuplicateView[];
    contactFields: ContactFieldConflict[];
    authOverrides: AuthOverrideConflict[];
  };
  contactPlan: ContactPlanView;
  summary: MergeSummaryCounts;
}

export interface NodeMergeResult {
  dryRun: false;
  survivorId: string;
  absorbedId: string;
  mergedAt: string;
  node: ApiKgNode;
  summary: MergeSummaryCounts & { conflictsResolved: number; contactReferencesRepointed: number };
  contactMerge: { survivingContactId: string; mergedContactIds: string[]; repointedContactIds: string[] } | null;
  warnings: string[];
}

export type MergeCandidateReason = 'same_label' | 'alias_match' | 'similar_embedding';

export interface MergeCandidate {
  node: ApiKgNode;
  score: number;
  reasons: MergeCandidateReason[];
}

// ---------------------------------------------------------------------------
// Plan — pure output of planner.ts; the preview plus the internal operations
// ---------------------------------------------------------------------------

export interface FactMove {
  fact: SnapshotNode;
  linkEdgeIds: string[];
}

/** An absorbed fact that is a duplicate of a survivor fact; the survivor's fact is kept. */
export interface FactCollapse {
  survivorFact: SnapshotNode;
  absorbedFact: SnapshotNode;
}

export interface FactConflictPlan {
  id: string;
  attribute: string;
  survivorFact: SnapshotNode;
  absorbedFact: SnapshotNode;
  absorbedLinkEdgeIds: string[];
  default: FactChoice;
}

export interface NearDuplicatePlan {
  id: string;
  survivorFact: SnapshotNode;
  absorbedFact: SnapshotNode;
  absorbedLinkEdgeIds: string[];
  similarity: number;
}

export interface FactPlan {
  moves: FactMove[];
  collapses: FactCollapse[];
  conflicts: FactConflictPlan[];
  nearDuplicates: NearDuplicatePlan[];
  /** Facts linked to both nodes: kept once; these absorbed-side link edges are deleted. */
  sharedFactIds: string[];
  sharedLinkEdgeIds: string[];
}

export interface EdgeCollapsePlan {
  absorbedEdge: SnapshotEdge;
  survivorEdge: SnapshotEdge;
}

export interface EdgePlan {
  /** Edges between the two nodes — they would become self-loops. */
  dropped: SnapshotEdge[];
  collapsed: EdgeCollapsePlan[];
  moved: SnapshotEdge[];
}

export interface ContactFieldConflictPlan {
  field: ContactMergeField;
  survivorValue: string;
  absorbedValue: string;
}

export interface AuthOverrideConflictPlan {
  permission: string;
  survivorGranted: boolean;
  absorbedGranted: boolean;
  /** The merged-away contact holding the conflicting override. */
  absorbedContactId: string;
}

export interface ContactPlan {
  action: 'none' | 'merge' | 'repoint';
  /** The single contact a person survivor ends up with (null for organization / other types). */
  surviving: SnapshotContact | null;
  /** Which node the surviving contact was linked to before the merge. */
  survivingFrom: Side | null;
  /** Contacts folded into `surviving` and deleted, in fold order. */
  merged: SnapshotContact[];
  /** Contacts re-pointed to the survivor node, with the kind they end up with. */
  repointed: { contact: SnapshotContact; kind: ContactKind }[];
  resultingKind: ContactKind | null;
  /** Non-conflicting resolved field values (survivor's, else the first non-null). */
  fieldBase: Record<ContactMergeField, string | null>;
  fieldConflicts: ContactFieldConflictPlan[];
  authOverrideConflicts: AuthOverrideConflictPlan[];
}

export interface NodePlan {
  /** Survivor properties ∪ non-reserved absorbed properties; conflicting keys hold the survivor value. */
  mergedProperties: Record<string, unknown>;
  propertyConflicts: PropertyConflict[];
  confidence: number;
  decayClass: DecayClass;
  sensitivity: Sensitivity;
  createdAt: string;
  lastConfirmedAt: string;
  warnedAt: string | null;
  warnReason: string | null;
  identitySource: IdentitySource;
}

export interface MergePlan {
  planToken: string;
  snapshot: MergeSnapshot;
  preview: NodeMergePreview;
  node: NodePlan;
  facts: FactPlan;
  edges: EdgePlan;
  contacts: ContactPlan;
}

// ---------------------------------------------------------------------------
// Execution plan — pure output of resolve.ts, consumed by executor.ts
// ---------------------------------------------------------------------------

export interface FactUpdateOp {
  id: string;
  confidence: number;
  lastConfirmedAt: string;
  sensitivity: Sensitivity;
  properties: Record<string, unknown>;
}

export interface FactOperations {
  /** Fact nodes to delete (their link edges cascade). */
  deleteFactIds: string[];
  /** Absorbed-side link edges re-pointed from the absorbed node to the survivor. */
  relinkEdgeIds: string[];
  /** Absorbed-side link edges of facts shared by both nodes. */
  deleteLinkEdgeIds: string[];
  updates: FactUpdateOp[];
  movedFactCount: number;
  collapsedFactCount: number;
}

export interface EdgeCollapseOp {
  survivorEdgeId: string;
  absorbedEdgeId: string;
  confidence: number;
  lastConfirmedAt: string;
  decayClass: DecayClass;
  properties: Record<string, unknown>;
}

export interface EdgeOperations {
  /** Self-loop edges and the absorbed side of collapsed edges. Deleted before any move. */
  deleteEdgeIds: string[];
  collapses: EdgeCollapseOp[];
  moveEdgeIds: string[];
}

export interface ContactOperations {
  action: 'none' | 'merge' | 'repoint';
  survivingContactId: string | null;
  /** kg_node_id → survivor, kind as given. Runs before the merges. */
  repoints: { contactId: string; kind: ContactKind }[];
  /** Contacts folded into survivingContactId, in order. */
  merges: { secondaryId: string; overridesPreferSecondary: string[] }[];
  /** The surviving contact row written by each fold; null when there is no fold. */
  mergedRow: MergedContactRow | null;
  mergedContactIds: string[];
  repointedContactIds: string[];
  /** True when the surviving contact is the principal (identities refresh after commit). */
  survivingIsPrincipal: boolean;
}

export interface NodeUpdateOp {
  label: string;
  labelChanged: boolean;
  aliases: string[];
  properties: Record<string, unknown>;
  confidence: number;
  decayClass: DecayClass;
  sensitivity: Sensitivity;
  createdAt: string;
  lastConfirmedAt: string;
  warnedAt: string | null;
  warnReason: string | null;
  identitySource: IdentitySource;
}

export interface ExecutionPlan {
  survivorId: string;
  absorbedId: string;
  mergedAt: string;
  survivor: { id: string; type: string; label: string };
  absorbed: { id: string; type: string; label: string };
  crossType: boolean;
  node: NodeUpdateOp;
  facts: FactOperations;
  edges: EdgeOperations;
  contacts: ContactOperations;
  summary: MergeSummaryCounts & { conflictsResolved: number };
  /** The resolutions as applied, with every default filled in (audit payload). */
  resolutions: Required<NodeMergeResolutions>;
}
