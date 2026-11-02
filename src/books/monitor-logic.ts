// monitor-logic.ts — what the books monitor decides to say, as pure functions of an injected clock and the facts.
//
// The checks (FR-INT-5):
//   reminder     the weekly reminder job's latest fire time has passed and some expected account has no file yet
//   deadline     the deadline job's latest fire time (default Tuesday 12:00 Toronto) has passed with accounts missing;
//                repeats daily until they arrive
//   unprocessed  a bank file has sat in the Drive folder for 60 minutes with no run report since it arrived
//   silent       the Mac mini has not checked in for 60 minutes (only once it has ever checked in)
// A `deferred` run (usage limit) is never a missed deadline and silences deadline, unprocessed and silent alerts.
// A `failed` run is announced the moment its report arrives, not here.
//
// Notification text carries only account ids, the week and which check fired. Never amounts, bank text or file contents.

import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';

export const SILENCE_MS = 60 * 60_000;
export const UNPROCESSED_MS = 60 * 60_000;
export const REPEAT_MS = 24 * 60 * 60_000;

export interface JobTiming {
  cronExpr: string;
  timezone: string;
  /** false when the job is paused, cancelled or suspended: its check is off. */
  enabled: boolean;
}

export interface RunFact {
  receivedAt: Date;
  status: 'ready' | 'failed' | 'deferred';
  accountsReceived: string[];
  expectedAccounts: string[];
}

export interface WaitingFile {
  id: string;
  modifiedTime: Date;
}

export interface MonitorFacts {
  now: Date;
  reminder: JobTiming | null;
  deadline: JobTiming | null;
  /** Accounts the books agent expects a file for, from the most recent run report that named them. */
  expectedAccounts: string[];
  /** Runs received since the start of the current deadline's week, newest first. */
  recentRuns: RunFact[];
  /** Newest run overall, newest first (used for the unprocessed-file and deferred checks). */
  lastRun: RunFact | null;
  heartbeat: { lastSeenAt: Date; state: string | null } | null;
  /** Files waiting in the Drive folder, or null when the folder is not configured/readable. */
  waitingFiles: WaitingFile[] | null;
}

export interface MonitorState {
  [key: string]: string | undefined; // ISO timestamps / marker strings per notified condition
}

export interface Alert {
  /** Stable key for the condition, stored so it is not repeated early. */
  key: string;
  title: string;
  message: string;
  /** Marker value stored under `key` once sent. */
  marker: string;
  /** Record the marker but send nothing. */
  silent?: boolean;
}

/** The latest time the cron fired at or before `now`, or null when it never has. */
export function lastFire(timing: JobTiming, now: Date): Date | null {
  try {
    return CronExpressionParser.parse(timing.cronExpr, { tz: timing.timezone, currentDate: now }).prev().toDate();
  } catch {
    return null;
  }
}

/** Monday 00:00 (in the job's timezone) of the week containing `instant`. */
export function weekStart(instant: Date, timezone: string): Date {
  return DateTime.fromJSDate(instant, { zone: timezone }).startOf('week').toJSDate();
}

const fmtDay = (d: Date, tz: string): string => DateTime.fromJSDate(d, { zone: tz }).toFormat('ccc d LLL, HH:mm');

function missingAccounts(expected: string[], runs: RunFact[]): string[] {
  const got = new Set(runs.flatMap(r => r.accountsReceived));
  return expected.filter(a => !got.has(a));
}

function elapsed(since: string | undefined, now: Date): number {
  if (!since) return Infinity;
  const t = Date.parse(since);
  return Number.isNaN(t) ? Infinity : now.getTime() - t;
}

export function decide(facts: MonitorFacts, state: MonitorState): Alert[] {
  const { now } = facts;
  const alerts: Alert[] = [];
  const deferred = facts.lastRun?.status === 'deferred';
  const expected = facts.expectedAccounts;

  // -- weekly reminder and deadline --
  const reminder = facts.reminder;
  if (reminder?.enabled) {
    const fired = lastFire(reminder, now);
    if (fired && now.getTime() - fired.getTime() < REPEAT_MS && state['reminder'] !== fired.toISOString()) {
      const missing = missingAccounts(expected, facts.recentRuns.filter(r => r.receivedAt >= weekStart(fired, reminder.timezone)));
      const due = facts.deadline ? fmtDay(nextAfter(facts.deadline, fired), facts.deadline.timezone) : 'the deadline';
      alerts.push({
        key: 'reminder',
        title: 'Books: files due',
        message: `Last week's bank files are due by ${due}. Drop them in the Drive folder${missing.length ? ` (still needed: ${missing.join(', ')})` : ''}.`,
        marker: fired.toISOString(),
        // Everything already arrived: record the reminder as handled without bothering anyone.
        silent: expected.length > 0 && missing.length === 0,
      });
    }
  }

  if (facts.deadline?.enabled && !deferred) {
    const fired = lastFire(facts.deadline, now);
    if (fired) {
      const since = weekStart(fired, facts.deadline.timezone);
      const missing = missingAccounts(expected, facts.recentRuns.filter(r => r.receivedAt >= since));
      const marker = `${fired.toISOString()}|${now.toISOString()}`;
      const last = state['deadline'];
      const sameDeadline = last?.startsWith(fired.toISOString());
      const sentAt = last?.split('|')[1];
      if (missing.length > 0 && (!sameDeadline || elapsed(sentAt, now) >= REPEAT_MS)) {
        alerts.push({
          key: 'deadline',
          title: 'Books: files overdue',
          message: `The bank files were due ${fmtDay(fired, facts.deadline.timezone)} and are still missing for: ${missing.join(', ')}.`,
          marker,
        });
      }
    }
  }

  // -- a file nobody processed --
  if (!deferred && facts.waitingFiles) {
    const lastRunAt = facts.lastRun?.receivedAt ?? null;
    const stuck = facts.waitingFiles.filter(
      f => now.getTime() - f.modifiedTime.getTime() >= UNPROCESSED_MS && (!lastRunAt || lastRunAt < f.modifiedTime),
    );
    if (stuck.length > 0) {
      const ids = stuck.map(f => f.id).sort().join(',');
      const last = state['unprocessed'];
      if (!last?.startsWith(ids) || elapsed(last.split('|')[1], now) >= REPEAT_MS) {
        alerts.push({
          key: 'unprocessed',
          title: 'Books: file not processed',
          message: `${stuck.length} bank file${stuck.length === 1 ? ' has' : 's have'} been waiting in the Drive folder for over an hour with no run since. The Mac mini may be down or locked.`,
          marker: `${ids}|${now.toISOString()}`,
        });
      }
    }
  }

  // -- the Mac mini went quiet --
  if (!deferred && facts.heartbeat && now.getTime() - facts.heartbeat.lastSeenAt.getTime() >= SILENCE_MS) {
    const seen = facts.heartbeat.lastSeenAt.toISOString();
    const last = state['silent'];
    if (!last?.startsWith(seen) || elapsed(last.split('|')[1], now) >= REPEAT_MS) {
      alerts.push({
        key: 'silent',
        title: 'Books: Mac mini silent',
        message: `The books Mac mini last checked in at ${seen.slice(0, 16).replace('T', ' ')} UTC. It may be off, locked after a power cut, or offline.`,
        marker: `${seen}|${now.toISOString()}`,
      });
    }
  }
  return alerts;
}

/** The first fire of a job strictly after `after`. */
function nextAfter(timing: JobTiming, after: Date): Date {
  try {
    return CronExpressionParser.parse(timing.cronExpr, { tz: timing.timezone, currentDate: after }).next().toDate();
  } catch {
    return after;
  }
}
