/**
 * Reject tool inputs the manifest does not declare.
 *
 * A handler that destructures only the keys it knows silently drops the rest, and
 * reports success for a request it did not carry out. On 2026-10-31 the calendar
 * specialist passed `recurrence` to calendar-create-event before that input existed;
 * the tool created a single event and returned success (#2385). Write skills whose
 * success the model reports back to the principal should name the unknown key instead.
 *
 * Returns an error message, or null when every key is declared.
 */
export function undeclaredInputError(
  input: Record<string, unknown>,
  declared: readonly string[],
): string | null {
  const unknown = Object.keys(input).filter((k) => !declared.includes(k));
  if (unknown.length === 0) return null;
  return `Unsupported input ${unknown.map((k) => `'${k}'`).join(', ')}: this tool does not accept ${unknown.length === 1 ? 'it' : 'them'}, so nothing was changed. Accepted inputs: ${declared.join(', ')}.`;
}
