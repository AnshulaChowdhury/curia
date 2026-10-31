// event-display.ts — shape a normalized calendar event for a skill result.
//
// Every timestamp a skill returns must be local ISO, not unix seconds (LLMs cannot
// convert timezones reliably; see "Timestamps" in CLAUDE.md). The calendar skills
// spread the whole event into their result, so each unix-second field has to be
// converted here, in one place, or a new field leaks through raw.

import type { NylasCalendarEvent } from './nylas-calendar-client.js';
import { toLocalIso } from '../../time/timestamp.js';

export type DisplayCalendarEvent = Omit<NylasCalendarEvent, 'startTime' | 'endTime' | 'originalStartTime'> & {
  startTime: string | null;
  endTime: string | null;
  originalStartTime?: string | null;
};

/** Convert the event's unix-second fields to local ISO strings in `tz` (UTC when unset). */
export function localizeEventTimes(event: NylasCalendarEvent, tz: string | undefined): DisplayCalendarEvent {
  const { originalStartTime, ...rest } = event;
  return {
    ...rest,
    startTime: toLocalIso(event.startTime, tz),
    endTime: toLocalIso(event.endTime, tz),
    ...(originalStartTime !== undefined ? { originalStartTime: toLocalIso(originalStartTime, tz) } : {}),
  };
}
