import { describe, expect, it } from 'vitest';
import { localDate, localMinutes, previousLocalDate, startOfLocalDay } from '../../../src/phone-brief/local-time.js';

const TORONTO = 'America/Toronto';

describe('local-time', () => {
  it('reads the local date and minutes in the zone, not UTC', () => {
    // 02:30Z on 2 Nov is 21:30 on 1 Nov in Toronto (EST after the 1 Nov fall-back).
    const ms = Date.parse('2026-11-02T02:30:00Z');
    expect(localDate(ms, TORONTO)).toBe('2026-11-01');
    expect(localMinutes(ms, TORONTO)).toBe(21 * 60 + 30);
  });

  it('finds local midnight, in summer and winter time', () => {
    expect(new Date(startOfLocalDay('2026-07-15', TORONTO)).toISOString()).toBe('2026-07-15T04:00:00.000Z'); // EDT, UTC-4
    expect(new Date(startOfLocalDay('2026-01-15', TORONTO)).toISOString()).toBe('2026-01-15T05:00:00.000Z'); // EST, UTC-5
  });

  it('is right on the days the clocks change', () => {
    // Fall back on 1 Nov 2026: midnight 1 Nov is still EDT, midnight 2 Nov is EST, so that day is 25 hours long.
    const start = startOfLocalDay('2026-11-01', TORONTO);
    const end = startOfLocalDay('2026-11-02', TORONTO);
    expect(new Date(start).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(new Date(end).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect((end - start) / 3_600_000).toBe(25);
    // Spring forward on 8 Mar 2026: 23-hour day.
    const s2 = startOfLocalDay('2026-03-08', TORONTO);
    const e2 = startOfLocalDay('2026-03-09', TORONTO);
    expect((e2 - s2) / 3_600_000).toBe(23);
  });

  it('steps back one date across month and year boundaries', () => {
    expect(previousLocalDate('2026-11-02')).toBe('2026-11-01');
    expect(previousLocalDate('2026-03-01')).toBe('2026-02-28');
    expect(previousLocalDate('2026-01-01')).toBe('2025-12-31');
  });
});
