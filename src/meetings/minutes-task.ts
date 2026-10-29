// minutes-task.ts — when a meeting-minutes task still needs repair (#2322).
//
// A tagged task is enough to suppress a second minutes.ready only once it can
// actually run: non-terminal, the structuring skill is active, and a wake is
// pending or running. nextWakeAt is not that check — a running wake with no
// deferred time has a null nextWakeAt and would look unfinished.

import type { Pool } from 'pg';
import { readActiveSkillNames } from '../db/active-skills-progress.js';
import { consoleOrigin } from '../scheduler/job-notification-context.js';
import type { MinutesRecap } from './types.js';

export const MINUTES_STRUCTURING_SKILL = 'meeting-minutes-structuring';

/** Office link that opens a working document in the console's Documents view (#2347). */
export function documentConsoleUrl(appOrigin: string | undefined, httpPort: number, path: string): string {
  return `${consoleOrigin(appOrigin, httpPort)}/documents?path=${encodeURIComponent(path)}`;
}

const RECAP_LINES: Record<MinutesRecap, string> = {
  requested: 'Recap: send one. The caller asked for notes or a recap.',
  topic_covered: 'Recap: send one. At least one agenda topic was covered.',
  not_earned: 'Recap: not earned. No agenda topic was covered and nobody asked for a recap.',
  unknown: 'Recap: decide from the minutes. Send one only if an agenda topic was covered or the caller asked for a recap.',
};

/**
 * The minutes task's first progress note. A task wake carries progress but not
 * the task description, so everything the follow-up needs goes here (#2347).
 * The storage path is for doc-read; the link is the one the report may show.
 */
export function minutesTaskNote(input: { minutesRef: string; minutesUrl: string; recap: MinutesRecap }): string {
  return [
    `Minutes for this call (read with doc-read): ${input.minutesRef}`,
    `Link that opens them in the office: ${input.minutesUrl}`,
    RECAP_LINES[input.recap],
  ].join('\n');
}

const TERMINAL_MINUTES_STATUSES = new Set(['done', 'cancelled', 'failed']);

export function isTerminalMinutesTask(status: string): boolean {
  return TERMINAL_MINUTES_STATUSES.has(status);
}

/** True when this non-terminal task still needs the skill restored or a wake enqueued. */
export function minutesTaskNeedsRepair(
  task: { status: string; progress: Record<string, unknown> },
  hasActiveWake: boolean,
): boolean {
  if (isTerminalMinutesTask(task.status)) return false;
  if (!readActiveSkillNames(task.progress).includes(MINUTES_STRUCTURING_SKILL)) return true;
  return !hasActiveWake;
}

/**
 * Serialize create-or-reuse of the minutes task. The lock is session-level on
 * one pooled client; the task read and insert use other connections, and the
 * lock is held until those commits are visible.
 */
export async function withMinutesTaskLock<T>(pool: Pool, tag: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // Set when the unlock fails. Releasing with an error destroys the connection,
  // so the server drops the session-level lock instead of handing it back to the pool.
  let unlockError: Error | undefined;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [tag]);
    try {
      return await fn();
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [tag]);
      } catch (err) {
        unlockError = err instanceof Error ? err : new Error(String(err));
      }
    }
  } finally {
    client.release(unlockError);
  }
}
