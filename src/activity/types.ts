// types.ts — shapes for the console's job-level activity feed (#2251).
//
// An ActivityItem is one job: an agent.task and every row under it, including
// the tasks it delegated to specialists. The projection (projection.ts) builds
// these from audit_log at read time, so nothing here is stored.

/** Whether an item's consequential actions succeeded. */
export type ActivityOutcome = 'success' | 'partial' | 'failed';

/** Matched from autonomy_action_log; null when no row matched. */
export type ActivityAutonomy = 'autonomous' | 'approved' | null;

/** Where the console sends a click on the item. */
export type ActivityLink =
  | { kind: 'job'; jobId: string }
  | { kind: 'conversation'; conversationId: string; from: string; to: string };

export interface ActivityItem {
  /** The root agent.task event id. */
  id: string;
  /** ISO timestamp of the root agent.task. */
  ts: string;
  /** Agent id that ran the root job (the console shows its label). */
  actor: string;
  /** One line of what Curia did. Never contains a message or email body. */
  headline: string;
  /** Further lines for the same job: individual actions, failures, rollups. */
  details: string[];
  outcome: ActivityOutcome;
  autonomy: ActivityAutonomy;
  link: ActivityLink | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** True when the window held more jobs than were read. */
  hasMore: boolean;
  /** IANA timezone the item text uses (the principal's, else the office's). */
  timezone: string;
}
