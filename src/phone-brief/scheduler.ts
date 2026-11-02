// scheduler.ts — runs the brief job once a day at 06:30 local time.
//
// A timer checks every minute. It generates when the local time is past 06:30 and the brief for today's date has not
// run yet, so a restart or deploy after 06:30 still produces the brief (until midday: a "morning" brief at night is
// worse than none). A failure is retried a few times, spaced out, and then the day is left without one (the route
// answers 204; it never serves yesterday's).

import type { Logger } from '../logger.js';
import { localMinutes } from './local-time.js';
import type { PhoneBriefService } from './brief-service.js';

const RUN_AT_MINUTES = 6 * 60 + 30;
const LATEST_MINUTES = 12 * 60;
const CHECK_EVERY_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60_000;

export class PhoneBriefScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private attempts = new Map<string, { count: number; lastAt: number }>();

  constructor(
    private readonly service: PhoneBriefService,
    private readonly logger: Logger,
    private readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error({ err }, 'phone-brief: unhandled error in tick'));
    }, CHECK_EVERY_MS);
    // Check right away: a restart after 06:30 should not wait a minute.
    void this.tick().catch((err) => this.logger.error({ err }, 'phone-brief: unhandled error in first tick'));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const nowMs = this.now();
    const minutes = localMinutes(nowMs, this.timeZone);
    if (minutes < RUN_AT_MINUTES || minutes >= LATEST_MINUTES) return;

    const date = this.service.dateFor(nowMs);
    const tries = this.attempts.get(date);
    if (tries && (tries.count >= MAX_ATTEMPTS || nowMs - tries.lastAt < RETRY_AFTER_MS)) return;

    this.running = true;
    try {
      if (await this.service.hasRun(date)) return;
      this.attempts.set(date, { count: (tries?.count ?? 0) + 1, lastAt: nowMs });
      await this.service.generate(nowMs);
    } catch (err) {
      this.logger.error({ err, date }, 'phone-brief: could not generate the brief');
    } finally {
      this.running = false;
    }
  }
}
