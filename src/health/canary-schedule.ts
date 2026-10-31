// canary-schedule.ts — fires the health canaries at health.canary_schedule (#2229).
//
// The canaries used to run as a declarative scheduled_jobs row targeting agentId
// 'health-service'. That never worked: no agent of that name exists, so three
// independent guards stopped it. Stale-job cleanup cancelled the row at every boot
// (it was declared in code, not in agents/*.yaml), the scheduler fails jobs whose
// agent is not registered (#1898), and the bus refuses to publish an agent.task to
// one. Nothing would have marked the run complete either.
//
// Nothing here needs an agent, so it runs as a system timer, the same move #2013
// made for approval expiry. Unlike that sweep, this one keeps the cron: operators
// point heartbeat monitors at a daily ping and expect it at a fixed wall-clock time.
//
// Each wake fires for exactly one scheduled slot, and the next slot is always
// strictly after it, so a run never repeats for the same slot. A restart re-arms
// for the next slot after boot; a slot missed while the process was down is not
// replayed (the heartbeat monitor reports that gap, which is what it is for).

import { CronExpressionParser } from 'cron-parser';
import type { Logger } from '../logger.js';
import type { CanaryResult } from './types.js';

export interface CanaryScheduleOptions {
  cron: string;
  /** IANA timezone for wall-clock interpretation — the same one the scheduler uses. */
  timezone: string;
  runCanaries: () => Promise<CanaryResult[]>;
  logger: Logger;
  /** Injectable clock for tests. */
  now?: () => Date;
}

// Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1 ms. A sparse cron
// (monthly, yearly) wakes at this horizon and re-arms instead of firing early.
const MAX_TIMER_MS = 2_147_483_647;

export class CanarySchedule {
  private timer: NodeJS.Timeout | null = null;
  private runInFlight = false;
  private stopped = false;

  /** Throws on an invalid cron or timezone, so a bad health.canary_schedule fails boot. */
  constructor(private readonly opts: CanaryScheduleOptions) {
    this.nextSlotAfter(this.now());
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const next = this.nextSlotAfter(this.now());
    this.arm(next);
    this.opts.logger.info(
      { schedule: this.opts.cron, timezone: this.opts.timezone, nextRunAt: next.toISOString() },
      'Health canary schedule started',
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private nextSlotAfter(base: Date): Date {
    return CronExpressionParser.parse(this.opts.cron, { tz: this.opts.timezone, currentDate: base })
      .next()
      .toDate();
  }

  private arm(slot: Date): void {
    const delay = Math.min(Math.max(slot.getTime() - this.now().getTime(), 0), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.wake(slot), delay);
  }

  private wake(slot: Date): void {
    this.timer = null;
    if (this.stopped) return;

    // Woken at the horizon of a sparse cron, not at the slot: re-arm for the same slot.
    if (this.now().getTime() < slot.getTime()) {
      this.arm(slot);
      return;
    }

    // Strictly after the slot just served, and after now if this wake ran late —
    // a late wake skips the slots it slept through rather than firing them back to back.
    const base = new Date(Math.max(slot.getTime(), this.now().getTime()));
    this.arm(this.nextSlotAfter(base));
    this.fire(slot);
  }

  private fire(slot: Date): void {
    const { logger } = this.opts;
    if (this.runInFlight) {
      logger.warn({ slot: slot.toISOString() }, 'Health canary run skipped — previous run still in flight');
      return;
    }
    this.runInFlight = true;
    this.opts.runCanaries()
      .then((results) => {
        const failed = results.filter(r => r.status === 'fail').map(r => r.name);
        logger.info(
          { slot: slot.toISOString(), canaries: results.length, failed },
          'Health canary run complete',
        );
      })
      .catch((err: unknown) => {
        logger.error({ err, slot: slot.toISOString() }, 'Health canary run failed');
      })
      .finally(() => {
        this.runInFlight = false;
      });
  }
}
