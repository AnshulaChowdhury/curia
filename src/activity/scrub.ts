// scrub.ts — remove contact details from free text shown in the activity feed (#2251).
//
// Two feed strings are not built from structured fields: a conversational job's
// model-written summary and a scheduled job's label when it falls back to its
// task text. Both pass through here before display, whatever the model or the
// job author wrote.

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Phone numbers in their written forms: international with a leading +, or a
// North American 3-3-4 grouping. Plain digit runs and dates (2026-10-24) are
// left alone — the summaries are allowed to name a day.
const PHONE_RES = [
  /\+\d[\d\s().-]{6,}\d/g,
  /(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
];

/** Strip emails, links and phone numbers, then tidy the spacing left behind. */
export function scrubContactDetails(text: string): string {
  let out = text.replace(EMAIL_RE, '').replace(URL_RE, '');
  for (const re of PHONE_RES) out = out.replace(re, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}
