// local-time.ts — wall-clock helpers for a named IANA timezone (the brief's day boundaries are local, not UTC).

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function partsOf(ms: number, timeZone: string): LocalParts {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(formatted.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local calendar date (YYYY-MM-DD) at an instant. */
export function localDate(ms: number, timeZone: string): string {
  const p = partsOf(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since local midnight at an instant. */
export function localMinutes(ms: number, timeZone: string): number {
  const p = partsOf(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/** How far the zone is ahead of UTC at an instant, in ms (negative west of Greenwich). */
function offsetMs(ms: number, timeZone: string): number {
  const p = partsOf(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** The instant (unix ms) at which a local date starts, i.e. local 00:00. Correct across DST changes. */
export function startOfLocalDay(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const asIfUtc = Date.UTC(y, m - 1, d);
  let guess = asIfUtc - offsetMs(asIfUtc, timeZone);
  guess = asIfUtc - offsetMs(guess, timeZone); // second pass settles the offset when it differs at midnight
  return guess;
}

/** The previous local date. */
export function previousLocalDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
