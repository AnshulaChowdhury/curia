// keywords.ts — cheap keyword extraction for "from this sender, about these words" rules. No model, no dependencies.
//
// Words come from the subject and the short preview triage already has (never the body). Common words and mail
// boilerplate are dropped; subject words count more than preview words. Matching compares crude word stems, so
// "invoice" and "invoices" meet. The same functions run when a rule is suggested and when it is matched.

export const MAX_KEYWORDS = 5;
export const MIN_KEYWORD_LENGTH = 3;
export const MAX_KEYWORD_LENGTH = 40;

const STOPWORDS = new Set((
  'the and for are but not you your yours with this that these those from have has had was were will would could should can may might ' +
  'our ours his her hers its they them their theirs what when where which who whom why how all any each few more most other some such ' +
  'than too very just also into onto over under again further then once here there about above after before below between both during ' +
  'only own same out off down until while been being does did doing get got let say said see seen use used via per yes new now one two ' +
  'hello dear regards thanks thank please best kind warmly sincerely cheers sent email mail inbox message reply forward fwd view ' +
  'browser click link links unsubscribe subscription preferences update updates newsletter team hope wanted write writing reaching ' +
  'hey hiya morning afternoon evening today tomorrow yesterday week day days time soon attached attachment attachments enclosed'
).split(/\s+/));

/** Lower-case letters only, within the length limits; the shape every stored keyword has. */
export function normaliseKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const word = raw.trim().toLowerCase();
  if (word.length < MIN_KEYWORD_LENGTH || word.length > MAX_KEYWORD_LENGTH) return null;
  return /^\p{L}+$/u.test(word) ? word : null;
}

/** A crude stem, applied to both sides of a comparison: invoices → invoice, billing → bill, charged → charg. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** "Hi Anshula," at the start is a greeting and the reader's own name, not what the email is about. */
const GREETING = /^\s*(?:hi|hello|hey|dear)\s+\p{L}+/iu;

function words(text: string): string[] {
  return (text.replace(GREETING, ' ').toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => w.length >= MIN_KEYWORD_LENGTH && w.length <= MAX_KEYWORD_LENGTH && !STOPWORDS.has(w));
}

/** The most telling words of an email, best first, at most `max`. Subject words count three times as much as preview words. */
export function extractKeywords(subject: string, preview: string, max = MAX_KEYWORDS): string[] {
  const score = new Map<string, { points: number; order: number }>();
  let order = 0;
  const add = (list: string[], weight: number) => {
    for (const w of list) {
      const key = stem(w);
      const entry = score.get(key);
      if (entry) entry.points += weight;
      else score.set(key, { points: weight, order: order++ });
    }
  };
  const first = new Map<string, string>(); // stem → the word as written, for showing to the owner
  for (const w of [...words(subject), ...words(preview)]) if (!first.has(stem(w))) first.set(stem(w), w);
  add(words(subject), 3);
  add(words(preview), 1);
  return [...score.entries()]
    .sort((a, b) => b[1].points - a[1].points || a[1].order - b[1].order)
    .slice(0, max)
    .map(([key]) => first.get(key) ?? key);
}

/** How many of the rule's keywords appear in this email (by stem). */
export function keywordHits(ruleKeywords: string[], subject: string, preview: string): number {
  const present = new Set(words(`${subject} ${preview}`).map(stem));
  return [...new Set(ruleKeywords.map(stem))].filter((k) => present.has(k)).length;
}

/** A rule applies when its keywords show up: all of them for a one-word rule, at least two otherwise. */
export function keywordsMatch(ruleKeywords: string[], subject: string, preview: string): boolean {
  const needed = Math.min(2, new Set(ruleKeywords.map(stem)).size);
  return needed > 0 && keywordHits(ruleKeywords, subject, preview) >= needed;
}

/** Sorted, de-duplicated, valid keywords (1 to MAX_KEYWORDS), or null if any is invalid or there are too many or none. */
export function cleanKeywordList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_KEYWORDS) return null;
  const out = new Set<string>();
  for (const item of raw) {
    const word = normaliseKeyword(item);
    if (!word) return null;
    out.add(word);
  }
  return [...out].sort();
}
