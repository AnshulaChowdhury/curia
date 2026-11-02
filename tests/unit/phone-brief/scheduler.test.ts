import { describe, expect, it, vi } from 'vitest';
import { PhoneBriefScheduler } from '../../../src/phone-brief/scheduler.js';
import type { PhoneBriefService } from '../../../src/phone-brief/brief-service.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const TZ = 'America/Toronto';
// Toronto is UTC-5 on 2 Nov 2026 (EST).
const at = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00-05:00`);

function fake(hasRun = false) {
  const ran = new Set<string>(hasRun ? ['2026-11-02'] : []);
  const generate = vi.fn(async (nowMs: number) => { ran.add(new Date(nowMs).toISOString().slice(0, 10)); ran.add('2026-11-02'); });
  const svc = {
    dateFor: () => '2026-11-02',
    hasRun: async (d: string) => ran.has(d),
    generate,
  } as unknown as PhoneBriefService;
  return { svc, generate };
}

function scheduler(svc: PhoneBriefService, clock: { t: number }) {
  return new PhoneBriefScheduler(svc, logger, TZ, () => clock.t);
}

describe('PhoneBriefScheduler', () => {
  it('does nothing before 06:30', async () => {
    const { svc, generate } = fake();
    await scheduler(svc, { t: at('06:29') }).tick();
    expect(generate).not.toHaveBeenCalled();
  });

  it('generates at 06:30 and only once that day', async () => {
    const { svc, generate } = fake();
    const clock = { t: at('06:30') };
    const s = scheduler(svc, clock);
    await s.tick();
    clock.t = at('06:31');
    await s.tick();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('catches up after a restart later in the morning', async () => {
    const { svc, generate } = fake();
    await scheduler(svc, { t: at('09:15') }).tick();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not build a "morning" brief from midday on', async () => {
    const { svc, generate } = fake();
    await scheduler(svc, { t: at('12:00') }).tick();
    await scheduler(svc, { t: at('22:00') }).tick();
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not regenerate a day that already has a brief', async () => {
    const { svc, generate } = fake(true);
    await scheduler(svc, { t: at('07:00') }).tick();
    expect(generate).not.toHaveBeenCalled();
  });

  it('retries a failure after a pause, and gives up after three tries', async () => {
    const generate = vi.fn(async () => { throw new Error('db down'); });
    const svc = { dateFor: () => '2026-11-02', hasRun: async () => false, generate } as unknown as PhoneBriefService;
    const clock = { t: at('06:30') };
    const s = scheduler(svc, clock);
    await s.tick();
    clock.t = at('06:35'); // too soon
    await s.tick();
    expect(generate).toHaveBeenCalledTimes(1);
    clock.t = at('06:41');
    await s.tick();
    clock.t = at('06:52');
    await s.tick();
    clock.t = at('07:30');
    await s.tick();
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
