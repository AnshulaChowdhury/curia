// errors.ts — typed failures of the node merge (spec: docs/wip/2026-10-21-kg-node-merge-design.md §7–§8).
//
// Each class carries a stable `code` so the HTTP route maps it to a status without
// string matching (CLAUDE.md: structured errors, not message parsing).

import type { MergeBlocker } from './types.js';

/** A node is missing, or archived (a tombstone of an earlier merge). → 404 node_not_found */
export class NodeNotFoundError extends Error {
  readonly code = 'node_not_found' as const;
  constructor(readonly nodeId: string) {
    super(`Knowledge-graph node not found: ${nodeId}`);
    this.name = 'NodeNotFoundError';
  }
}

/** The plan token no longer matches the data: the graph changed since the preview. → 409 */
export class StalePreviewError extends Error {
  readonly code = 'stale_preview' as const;
  constructor() {
    super('The graph changed since this merge was previewed. Preview it again.');
    this.name = 'StalePreviewError';
  }
}

/** The merge cannot be applied as planned. → 422 blocked */
export class MergeBlockedError extends Error {
  readonly code = 'blocked' as const;
  constructor(readonly blockers: MergeBlocker[]) {
    super(
      blockers.length === 1
        ? `Merge blocked: ${blockers[0]!.message}`
        : `Merge blocked: ${blockers.map(b => b.message).join(' ')}`,
    );
    this.name = 'MergeBlockedError';
  }
}

export type InvalidResolutionCode = 'invalid_request' | 'ack_required' | 'unknown_resolution';

/** The request or its resolutions do not fit the plan. → 400 with the given code */
export class InvalidResolutionError extends Error {
  constructor(readonly code: InvalidResolutionCode, message: string) {
    super(message);
    this.name = 'InvalidResolutionError';
  }
}
