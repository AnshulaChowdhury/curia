// monitor.ts — the books monitor: seeds the weekly scheduler jobs, checks every 15 minutes, notifies the reviewers.
//
// The weekly reminder (Monday 08:00) and deadline (Tuesday 12:00 America/Toronto) are ordinary scheduler jobs, seeded once
// when the books feature is first enabled, so the owner changes a time, pauses or resumes them with `scheduler-update`
// like any other job (FR-INT-8). Their cron and timezone are the timing; this monitor reads the rows and does the
// notifying itself, deterministically, within one 15-minute tick of a fire time. When the scheduler fires a row it runs
// a harmless coordinator checkpoint task (the scheduler can only run jobs through a registered agent).

import type { Logger } from '../logger.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { BooksToken } from '../quickbooks/books-token.js';
import type { DriveInbox } from './drive-inbox.js';
import { decide, lastFire, weekStart, type MonitorFacts, type RunFact, type WaitingFile } from './monitor-logic.js';
import type { BooksNotifier } from './notifier.js';
import type { MonitorStore, NewRun } from './monitor-store.js';

export const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 60_000;
const DEFAULT_TIMEZONE = 'America/Toronto';

const CHECKPOINT_TASK = (what: string): string =>
  `Books checkpoint (${what}). Curia's books monitor sends the notification itself, so do not message anyone and do not use any other skill. ` +
  `Call scheduler-report with the summary "handled by the books monitor".`;

export interface MonitorDeps {
  store: MonitorStore;
  notifier: BooksNotifier;
  driveInbox: Pick<DriveInbox, 'list'>;
  schedulerService: Pick<SchedulerService, 'createJob'>;
  booksToken: Pick<BooksToken, 'isSet'>;
  logger: Logger;
  now?: () => Date;
}

export interface BooksStatus {
  heartbeat: { lastSeenAt: string; ageMinutes: number; state: string | null; version: string | null } | null;
  lastRun: { receivedAt: string; status: string; batchId: string | null } | null;
  week: { since: string; expectedAccounts: string[]; received: string[]; missing: string[] };
  jobs: { reminder: { cronExpr: string; timezone: string; enabled: boolean } | null; deadline: { cronExpr: string; timezone: string; enabled: boolean } | null };
  lastNotifiedAt: string | null;
}

export class BooksMonitor {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: MonitorDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(): void {
    if (this.timer) return;
    this.first = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** A failed run is announced the moment its report arrives (FR-INT-5), whatever the schedule says. */
  async onRunReported(run: NewRun): Promise<void> {
    if (run.status !== 'failed') return;
    await this.send('Books: run failed', 'The weekly books run failed. Open the Books page or the Mac mini log for the reason.');
  }

  /** Creates the weekly jobs the first time the books feature is enabled; never again, even if the owner removed them. */
  async ensureSeeded(): Promise<boolean> {
    const { store, schedulerService, booksToken, logger } = this.deps;
    const state = await store.getState();
    if (state['jobs_seeded']) return false;
    if (!(await booksToken.isSet())) return false;
    try {
      await schedulerService.createJob({
        agentId: 'coordinator',
        cronExpr: '0 8 * * 1',
        timezone: DEFAULT_TIMEZONE,
        taskPayload: { task: CHECKPOINT_TASK('Monday reminder'), books_job: 'reminder' },
        createdBy: 'books',
      });
      await schedulerService.createJob({
        agentId: 'coordinator',
        cronExpr: '0 12 * * 2',
        timezone: DEFAULT_TIMEZONE,
        taskPayload: { task: CHECKPOINT_TASK('Tuesday deadline'), books_job: 'deadline' },
        createdBy: 'books',
      });
    } catch (err) {
      logger.error({ err }, 'books: could not create the weekly jobs; will try again next check');
      return false;
    }
    await store.setState('jobs_seeded', this.now().toISOString());
    logger.info('books: weekly reminder and deadline jobs created');
    return true;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { store, logger } = this.deps;
    try {
      await this.ensureSeeded();
      const facts = await this.gather();
      const state = await store.getState();
      for (const alert of decide(facts, state)) {
        if (!alert.silent) await this.send(alert.title, alert.message);
        await store.setState(alert.key, alert.marker);
      }
    } catch (err) {
      logger.error({ err }, 'books: the 15-minute check failed');
    } finally {
      this.running = false;
    }
  }

  private async send(title: string, message: string): Promise<void> {
    const sent = await this.deps.notifier.notify(title, message);
    await this.deps.store.setState('last_notified_at', this.now().toISOString());
    this.deps.logger.info({ title, sent }, 'books: notification sent');
  }

  private async waitingFiles(): Promise<WaitingFile[] | null> {
    try {
      const files = await this.deps.driveInbox.list();
      return files.map(f => ({ id: f.id, modifiedTime: new Date(f.modifiedTime) })).filter(f => !Number.isNaN(f.modifiedTime.getTime()));
    } catch {
      return null; // not configured or Google unavailable: skip the unprocessed-file check
    }
  }

  private async gather(): Promise<MonitorFacts> {
    const { store } = this.deps;
    const now = this.now();
    const [reminder, deadline, expectedAccounts, lastRun, hb, waitingFiles] = await Promise.all([
      store.jobTiming('reminder'),
      store.jobTiming('deadline'),
      store.expectedAccounts(),
      store.lastRun(),
      store.getHeartbeat(),
      this.waitingFiles(),
    ]);
    // Runs since the Monday of the most recent deadline's (or reminder's) week.
    const anchor = (deadline && lastFire(deadline, now)) || (reminder && lastFire(reminder, now)) || now;
    const tz = deadline?.timezone ?? reminder?.timezone ?? DEFAULT_TIMEZONE;
    const recentRuns: RunFact[] = await store.runsSince(weekStart(anchor, tz));
    return {
      now,
      reminder,
      deadline,
      expectedAccounts,
      recentRuns,
      lastRun,
      heartbeat: hb ? { lastSeenAt: hb.lastSeenAt, state: hb.state } : null,
      waitingFiles,
    };
  }

  async status(): Promise<BooksStatus> {
    const now = this.now();
    const f = await this.gather();
    const state = await this.deps.store.getState();
    const hb = await this.deps.store.getHeartbeat();
    const tz = f.deadline?.timezone ?? f.reminder?.timezone ?? DEFAULT_TIMEZONE;
    const received = [...new Set(f.recentRuns.flatMap(r => r.accountsReceived))];
    const lastRun = await this.deps.store.lastRun();
    const job = (t: typeof f.reminder) => (t ? { cronExpr: t.cronExpr, timezone: t.timezone, enabled: t.enabled } : null);
    return {
      heartbeat: hb ? { lastSeenAt: hb.lastSeenAt.toISOString(), ageMinutes: Math.round((now.getTime() - hb.lastSeenAt.getTime()) / 60_000), state: hb.state, version: hb.version } : null,
      lastRun: lastRun ? { receivedAt: lastRun.receivedAt.toISOString(), status: lastRun.status, batchId: lastRun.batchId } : null,
      week: {
        since: weekStart((f.deadline && lastFire(f.deadline, now)) || now, tz).toISOString(),
        expectedAccounts: f.expectedAccounts,
        received,
        missing: f.expectedAccounts.filter(a => !received.includes(a)),
      },
      jobs: { reminder: job(f.reminder), deadline: job(f.deadline) },
      lastNotifiedAt: state['last_notified_at'] ?? null,
    };
  }
}
