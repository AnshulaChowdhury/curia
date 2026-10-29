// minutes-task.ts — when a meeting-minutes task still needs repair (#2322).
//
// A tagged task is enough to suppress a second minutes.ready only once it can
// actually run: non-terminal, the structuring skill is active, and a wake is
// pending or running. nextWakeAt is not that check — a running wake with no
// deferred time has a null nextWakeAt and would look unfinished.

import type { Pool } from 'pg';
import { readActiveSkillNames } from '../db/active-skills-progress.js';

export const MINUTES_STRUCTURING_SKILL = 'meeting-minutes-structuring';

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
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [tag]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [tag]);
    }
  } finally {
    client.release();
  }
}
