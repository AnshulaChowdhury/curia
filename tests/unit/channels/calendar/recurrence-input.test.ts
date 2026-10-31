import { describe, it, expect } from 'vitest';
import { parseRecurrence } from '../../../../src/channels/calendar/recurrence-input.js';

// 2026-11-02 is a Monday. 14:00Z is 9:00 AM in Toronto (EST).
const MONDAY_9AM = '2026-11-02T14:00:00.000Z';
const TZ = 'America/Toronto';

describe('parseRecurrence', () => {
  it('accepts a weekly rule whose BYDAY includes the start day', () => {
    const out = parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO'], { start: MONDAY_9AM, timezone: TZ });
    expect(out).toEqual({ ok: true, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
  });

  it('accepts an RRULE with EXDATE lines', () => {
    const lines = ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Toronto:20261221T090000'];
    expect(parseRecurrence(lines, { start: MONDAY_9AM, timezone: TZ }).ok).toBe(true);
  });

  it('checks the start day in the given timezone, not UTC', () => {
    // 02:00Z Tuesday is still Monday evening in Toronto.
    const out = parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO'], { start: '2026-11-03T02:00:00.000Z', timezone: TZ });
    expect(out.ok).toBe(true);
  });

  it('rejects a weekly rule whose BYDAY excludes the start day', () => {
    const out = parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=TU'], { start: MONDAY_9AM, timezone: TZ });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Monday/);
  });

  it('skips the weekday check when no start is given (series edit without a time change)', () => {
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=TU'], { timezone: TZ }).ok).toBe(true);
  });

  it('rejects a non-array', () => {
    expect(parseRecurrence('RRULE:FREQ=WEEKLY', { timezone: TZ }).ok).toBe(false);
  });

  it('rejects an empty array', () => {
    expect(parseRecurrence([], { timezone: TZ }).ok).toBe(false);
  });

  it('rejects a non-string entry', () => {
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY', 7], { timezone: TZ }).ok).toBe(false);
  });

  it('rejects a line without an RRULE/EXDATE/RDATE prefix', () => {
    const out = parseRecurrence(['FREQ=WEEKLY;BYDAY=MO'], { timezone: TZ });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/RRULE:/);
  });

  it('rejects two RRULE lines', () => {
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO', 'RRULE:FREQ=DAILY'], { timezone: TZ }).ok).toBe(false);
  });

  it('rejects lines with no RRULE at all', () => {
    expect(parseRecurrence(['EXDATE:20261221T140000Z'], { timezone: TZ }).ok).toBe(false);
  });

  it('rejects an RRULE whose FREQ is not an RFC 5545 frequency', () => {
    const out = parseRecurrence(['RRULE:FREQ=NOT_A_FREQUENCY'], { timezone: TZ });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/FREQ/);
  });

  it('accepts a lower-case FREQ value', () => {
    expect(parseRecurrence(['RRULE:freq=weekly;byday=mo'], { start: MONDAY_9AM, timezone: TZ }).ok).toBe(true);
  });

  it('returns an error, not a throw, when start is not a valid date', () => {
    const out = parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO'], { start: 'tomorrow', timezone: TZ });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/start/);
  });

  it('rejects an RRULE without FREQ', () => {
    expect(parseRecurrence(['RRULE:BYDAY=MO'], { timezone: TZ }).ok).toBe(false);
  });
});
