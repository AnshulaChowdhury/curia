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
  const parts = new Map(
    rrules[0]!.slice('RRULE:'.length).split(';').map((p) => {
      const [k, v] = p.split('=');
      return [(k ?? '').toUpperCase(), v ?? ''] as const;
    }),
  );
  if (!parts.get('FREQ')) {
    return { ok: false, error: 'Invalid input: the RRULE must set FREQ (e.g. FREQ=WEEKLY)' };
  }

  const byday = parts.get('BYDAY');
  if (opts.start && parts.get('FREQ') === 'WEEKLY' && byday) {
    const codes = byday.split(',').map((d) => d.trim().toUpperCase());
    // Only plain day codes; ordinal forms like 1MO belong to MONTHLY rules.
    if (codes.every((c) => c in BYDAY_CODES)) {
      const startDay = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: opts.timezone })
        .format(new Date(opts.start));
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
