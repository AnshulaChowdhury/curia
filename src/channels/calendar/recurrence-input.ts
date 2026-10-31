// recurrence-input.ts — validate the `recurrence` input of the calendar write skills.
//
// Recurrence is a list of RFC 5545 lines: exactly one `RRULE:`, plus optional
// `EXDATE`/`RDATE` lines (which may carry parameters, e.g. `EXDATE;TZID=…:`).
// We check shape here so a malformed rule fails before any Nylas call, rather
// than surfacing as a provider 400 or, worse, a series on the wrong days.

export type ParseRecurrenceResult =
  | { ok: true; recurrence: string[] }
  | { ok: false; error: string };

const MAX_LINES = 20;
const LINE_PREFIX = /^(RRULE:|EXDATE[:;]|RDATE[:;])/;
// RFC 5545 §3.3.10 FREQ values. Values are case-insensitive.
const FREQUENCIES = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const BYDAY_CODES: Record<string, string> = {
  SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday',
};

/**
 * Validate a model-supplied `recurrence` value.
 *
 * When `start` is given and the rule is a plain weekly BYDAY rule, also check
 * that the start falls on one of those days (in `timezone`). Google counts the
 * first event as an occurrence even when it is off-pattern, so a Tuesday start
 * on a Monday rule silently produces a stray Tuesday meeting.
 */
export function parseRecurrence(
  value: unknown,
  opts: { start?: string; timezone: string },
): ParseRecurrenceResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'Invalid input: recurrence must be a non-empty array of RFC 5545 lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]' };
  }
  if (value.length > MAX_LINES) {
    return { ok: false, error: `Invalid input: recurrence has ${value.length} lines; at most ${MAX_LINES} are allowed` };
  }
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, error: 'Invalid input: every recurrence entry must be a non-empty string' };
    }
    const line = entry.trim();
    if (!LINE_PREFIX.test(line)) {
      return { ok: false, error: `Invalid input: recurrence line "${line}" must start with RRULE:, EXDATE or RDATE` };
    }
    lines.push(line);
  }

  const rrules = lines.filter((l) => l.startsWith('RRULE:'));
  if (rrules.length !== 1) {
    return { ok: false, error: `Invalid input: recurrence needs exactly one RRULE line (got ${rrules.length})` };
  }
  // Targeted property checks, not a full RFC 5545 validator: catch what would
  // otherwise reach the provider malformed or be silently collapsed.
  const parts = new Map<string, string>();
  for (const part of rrules[0]!.slice('RRULE:'.length).split(';')) {
    const eq = part.indexOf('=');
    const key = (eq === -1 ? part : part.slice(0, eq)).trim().toUpperCase();
    const value = eq === -1 ? '' : part.slice(eq + 1).trim().toUpperCase();
    if (!key || !value) {
      return { ok: false, error: `Invalid input: RRULE property "${part}" must be NAME=VALUE` };
    }
    if (parts.has(key)) {
      return { ok: false, error: `Invalid input: RRULE sets ${key} more than once` };
    }
    parts.set(key, value);
  }
  for (const key of ['COUNT', 'INTERVAL']) {
    const value = parts.get(key);
    if (value !== undefined && !/^[1-9]\d*$/.test(value)) {
      return { ok: false, error: `Invalid input: RRULE ${key} must be a positive integer (got "${value}")` };
    }
  }
  const until = parts.get('UNTIL');
  if (until !== undefined && !/^\d{8}(T\d{6}Z?)?$/.test(until)) {
    return { ok: false, error: `Invalid input: RRULE UNTIL must be a date (YYYYMMDD) or UTC date-time (YYYYMMDDTHHMMSSZ), got "${until}"` };
  }
  if (until !== undefined && parts.has('COUNT')) {
    return { ok: false, error: 'Invalid input: an RRULE may set COUNT or UNTIL, not both' };
  }
  const freq = parts.get('FREQ');
  if (!freq || !FREQUENCIES.has(freq)) {
    return {
      ok: false,
      error: `Invalid input: the RRULE must set FREQ to one of ${[...FREQUENCIES].join(', ')} (got ${freq ? `"${freq}"` : 'none'})`,
    };
  }

  const byday = parts.get('BYDAY');
  if (opts.start && freq === 'WEEKLY' && byday) {
    const codes = byday.split(',').map((d) => d.trim().toUpperCase());
    // Only plain day codes; ordinal forms like 1MO belong to MONTHLY rules.
    if (codes.every((c) => c in BYDAY_CODES)) {
      // Intl throws a RangeError on an Invalid Date; this function returns errors, never throws.
      const startMs = Date.parse(opts.start);
      if (Number.isNaN(startMs)) {
        return { ok: false, error: `Invalid input: start "${opts.start}" is not a valid date` };
      }
      const startDay = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: opts.timezone })
        .format(new Date(startMs));
      const allowed = codes.map((c) => BYDAY_CODES[c]!);
      if (!allowed.includes(startDay)) {
        return {
          ok: false,
          error: `Invalid input: start falls on a ${startDay} but the rule repeats on ${allowed.join(', ')}. Move start to the first ${allowed[0]} occurrence.`,
        };
      }
    }
  }

  return { ok: true, recurrence: lines };
}
