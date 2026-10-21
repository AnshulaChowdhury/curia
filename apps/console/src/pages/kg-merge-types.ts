// Console mirror of the node-merge API contract (src/kg-merge/types.ts,
// design §8). There is no shared package between the backend and the console,
// so keep this file in step with the backend by hand.

import type { ApiKgNode } from './kg-types.js';

export type { ApiKgNode };

export type Side = 'survivor' | 'absorbed';
export type FactChoice = Side | 'both';
export type NearDuplicateChoice = 'merge' | 'keep_both';

export interface NodeMergeResolutions {
  label?: Side;
  /** property key → side */
  properties?: Record<string, Side>;
  /** fact-conflict id (`fact:<survivorFactId>:<absorbedFactId>`) → choice */
  facts?: Record<string, FactChoice>;
  /** near-duplicate id (`near:<s>:<a>`) → choice */
  nearDuplicateFacts?: Record<string, NearDuplicateChoice>;
  /** contact field name → side */
  contactFields?: Record<string, Side>;
  /** permission → side */
  authOverrides?: Record<string, Side>;
  /** acknowledged warning codes */
  acknowledgements?: string[];
}

export interface MergeNodeContact {
  id: string;
  displayName: string;
  kind: string | null;
  systemRole: string | null;
  tier: string;
  identityCount: number;
}

export interface MergeNodeSummary {
  id: string;
  label: string;
  type: string;
  aliases: string[];
  identitySource: 'label' | 'contact';
  sensitivity: string;
  confidence: number;
  decayClass: string;
  lastConfirmedAt: string;
  factCount: number;
  edgeCount: number;
  contacts: MergeNodeContact[];
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

export interface PropertyConflict {
  key: string;
  survivorValue: unknown;
  absorbedValue: unknown;
  default: Side;
}

export interface FactConflict {
  id: string;
  attribute: string;
  survivor: MergeFactSummary;
  absorbed: MergeFactSummary;
  default: FactChoice;
}

export interface NearDuplicateFactConflict {
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

export interface MergeIdentity {
  channel: string;
  identifier: string;
  from: Side;
  duplicate: boolean;
  verified: boolean;
}

export interface MergeContactPlan {
  action: 'none' | 'merge' | 'repoint';
  survivingContactId: string | null;
  mergedContactIds: string[];
  repointedContactIds: string[];
  resultingKind: string | null;
  identities: MergeIdentity[];
}

export interface MergeSummaryCounts {
  factsMoved: number;
  factsCollapsed: number;
  edgesMoved: number;
  edgesCollapsed: number;
  edgesDropped: number;
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
    /** Aliases for the default label. */
    aliases: string[];
    droppedAliases: string[];
    sensitivity: string;
    confidence: number;
    decayClass: string;
    identitySource: 'label' | 'contact';
  };
  blockers: MergeBlocker[];
  warnings: MergeWarning[];
  conflicts: {
    properties: PropertyConflict[];
    facts: FactConflict[];
    nearDuplicateFacts: NearDuplicateFactConflict[];
    contactFields: ContactFieldConflict[];
    authOverrides: AuthOverrideConflict[];
  };
  contactPlan: MergeContactPlan;
  summary: MergeSummaryCounts;
}

export interface NodeMergeResult {
  dryRun: false;
  survivorId: string;
  absorbedId: string;
  mergedAt: string;
  /** The survivor after the merge, same shape as GET /api/kg/nodes. */
  node: ApiKgNode;
  summary: MergeSummaryCounts & { conflictsResolved: number; contactReferencesRepointed: number };
  contactMerge: { survivingContactId: string; mergedContactIds: string[]; repointedContactIds: string[] } | null;
  warnings: string[];
}

export interface NodeMergeRequest {
  survivorId: string;
  absorbedId: string;
  /** Defaults to true server-side. */
  dryRun?: boolean;
  /** Required when dryRun === false. */
  planToken?: string;
  resolutions?: NodeMergeResolutions;
}

export type MergeCandidateReason = 'same_label' | 'alias_match' | 'similar_embedding';

export interface MergeCandidate {
  node: ApiKgNode;
  score: number;
  reasons: MergeCandidateReason[];
}

export interface MergeCandidatesResponse {
  candidates: MergeCandidate[];
}

export type NodeMergeErrorCode =
  | 'invalid_request'
  | 'ack_required'
  | 'unknown_resolution'
  | 'node_not_found'
  | 'stale_preview'
  | 'blocked'
  | 'node_merged';

/** Error body of the merge routes and of the `node_merged` 404 on GET /api/kg/graph. */
export interface NodeMergeErrorBody {
  error: string;
  code?: NodeMergeErrorCode;
  blockers?: MergeBlocker[];
  mergedInto?: string;
}
