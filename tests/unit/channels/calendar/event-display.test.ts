import { describe, it, expect } from 'vitest';
import { localizeEventTimes } from '../../../../src/channels/calendar/event-display.js';
import type { NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';

const BASE: NylasCalendarEvent = {
  id: 'evt', title: 't', description: '', location: '',
  startTime: 1794232800, endTime: 1794233700, startDate: null, endDate: null,
  participants: [], conferencing: null, status: 'confirmed', calendarId: 'cal', busy: true, metadata: null,
};
const TZ = 'America/Toronto';

describe('localizeEventTimes', () => {
  it('converts start and end to local ISO strings', () => {
    const out = localizeEventTimes(BASE, TZ);
    expect(out.startTime).toBe('2026-11-09T09:00:00.000-05:00');
    expect(out.endTime).toBe('2026-11-09T09:15:00.000-05:00');
  });

  it("converts an occurrence's originalStartTime too, so no raw unix seconds reach the model", () => {
    const out = localizeEventTimes({ ...BASE, masterEventId: 'm', originalStartTime: 1794232800 }, TZ);
    expect(out.originalStartTime).toBe('2026-11-09T09:00:00.000-05:00');
    expect(out.masterEventId).toBe('m');
  });

  it('adds no originalStartTime key to a one-off event', () => {
    expect(localizeEventTimes(BASE, TZ)).not.toHaveProperty('originalStartTime');
  });
});
