// src/budget/month.ts — the month a budget tool asked for, or the current month in the owner's timezone.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The requested YYYY-MM, today's month when none was given, or null when the request is not a month. */
export function monthOf(requested: unknown, timezone: string, now: Date = new Date()): string | null {
  if (requested === undefined || requested === null || requested === '') {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}`;
  }
  return typeof requested === 'string' && MONTH.test(requested) ? requested : null;
}
