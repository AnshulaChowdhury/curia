// The approvals waiting on the principal's answer, on principal turns (#2333).
//
// A principal's "yes, share it with Dana" answers an approval only if the coordinator links
// it to one, and nothing on the turn said one was waiting: the backlog line gives a count,
// framed as something to raise later. In a paid run (34k, 2026-10-28) the coordinator met
// that "yes" with "I lost the thread". The dispatcher now lists the approvals the principal
// has been shown (src/dispatch/principal-backlog.ts) and the runtime renders them with the
// turn guidance, with how to read an answer: yes, no, a changed request, or none at all.
//
// The listed items vary by turn. The instruction lines are fixed, so they are a
// prompt-exfiltration marker source (trigger-guidance-sources.ts).

/** One approval the principal has been shown and not yet answered. */
export interface AwaitingAnswer {
  /** The number the principal was shown ("approve 3"); null for rows raised before numbers. */
  number: number | null;
  shortRef: string;
  description: string;
  /** A personal-data ask's question, as the principal was sent it (#2312). */
  question?: string;
  /** The principal's message is a reply on this approval's own email thread. */
  repliedTo?: boolean;
}

/** The most listed on one turn: the newest first. */
export const MAX_AWAITING_ANSWERS = 5;

/** Precedes the list. Fixed text. */
export const AWAITING_ANSWER_HEADER = 'Approvals the principal has been shown and not yet answered:';

/** Follows the list. Fixed text, hard-wrapped for marker extraction. */
export const AWAITING_ANSWER_LINES: readonly string[] = [
  'If their message answers one of these, act on that first, by its number:',
  '- yes, go ahead, share it: approve-action.',
  '- no, don\'t: deny-action.',
  '- a change to what is sent (another detail, other recipients, different words): deny-action,',
  '  then make the send they described. Their words direct it.',
  '- not yet, or a question back: leave it pending and answer them.',
  'If it is unclear which one it answers, or whether it answers one at all, ask them in one line.',
  'Never approve on a guess.',
];

/** Marks the approval whose email thread the principal replied on. Fixed text. */
export const REPLIED_TO_MARK = '(their message is a reply to this one)';

function clean(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Narrow an untrusted value (a bus payload field) to the list. An entry without a short ref
 * and a description is dropped; anything that is not an array is none.
 */
export function parseAwaitingAnswers(raw: unknown): AwaitingAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: AwaitingAnswer[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const shortRef = r['shortRef'];
    const description = r['description'];
    if (typeof shortRef !== 'string' || shortRef === '' || typeof description !== 'string' || description === '') continue;
    const number = typeof r['number'] === 'number' && Number.isInteger(r['number']) && r['number'] > 0 ? r['number'] : null;
    out.push({
      number,
      shortRef,
      description,
      ...(typeof r['question'] === 'string' && r['question'] !== '' ? { question: r['question'] } : {}),
      ...(r['repliedTo'] === true ? { repliedTo: true } : {}),
    });
    if (out.length === MAX_AWAITING_ANSWERS) break;
  }
  return out;
}

/** The block, or null when nothing is waiting on an answer. */
export function renderAwaitingAnswers(list: readonly AwaitingAnswer[]): string | null {
  if (list.length === 0) return null;
  const items = list.map((a) => {
    const ref = a.number !== null ? `Approval ${a.number}` : `Approval ${a.shortRef}`;
    const question = a.question ? ` Asked: "${clean(a.question, 300)}"` : '';
    return `- ${ref}: ${clean(a.description, 160).replace(/[.\s]+$/, '')}.${question}${a.repliedTo ? ` ${REPLIED_TO_MARK}` : ''}`;
  });
  return [AWAITING_ANSWER_HEADER, ...items, ...AWAITING_ANSWER_LINES].join('\n');
}
