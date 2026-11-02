// normalize.ts — identifiers are compared exactly, so they are put in one shape first: emails in lower case, phone
// numbers in E.164. Anything that cannot be put in that shape is dropped, never guessed at.

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RX = /^\+[1-9][0-9]{6,14}$/;
const MAX_EMAIL = 254;

/** Lower-cased address, or null if it is not an email address. */
export function normalizeEmail(value: string): string | null {
  const v = value.trim().toLowerCase();
  return v.length > 0 && v.length <= MAX_EMAIL && EMAIL_RX.test(v) ? v : null;
}

/**
 * E.164 number, or null. A number that already starts with "+" (or "00") keeps its own country code. A bare
 * 10-digit number, or an 11-digit one starting with 1, is taken as North American (+1), the stated default.
 * Anything else without a country code is rejected rather than guessed.
 */
export function normalizePhone(value: string): string | null {
  const raw = value.trim().replace(/^tel:/i, '');
  const digits = raw.replace(/\D/g, '');
  let candidate: string;
  if (raw.startsWith('+')) candidate = `+${digits}`;
  else if (raw.startsWith('00')) candidate = `+${digits.slice(2)}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) candidate = `+${digits}`;
  else return null;
  return E164_RX.test(candidate) ? candidate : null;
}

/** JSON with object keys sorted, so the same people always hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
