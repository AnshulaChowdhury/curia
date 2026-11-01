// types.ts — shared shapes for real-time inbox triage (the watcher, the classifier agent and the push).
//
// Requirements: MVOS business_analysis/email-triage-requirements.md (FR-ETW, FR-ETC, FR-ETP).

/** The triage groups that reach the phone. They match the Gmail labels the ceo-inbox agent applies. */
export const TRIAGE_GROUPS = ['urgent', 'drafted', 'seen'] as const;
export type TriageGroup = (typeof TRIAGE_GROUPS)[number];

/** Label text per group. phone-inbox's groupOfLabel() ignores the emoji and case, so these round-trip. */
export const TRIAGE_LABELS: Record<TriageGroup, string> = {
  urgent: '🚨 Urgent',
  drafted: '✍️ Drafted',
  seen: '📌 Seen',
};

/** One unread, untagged message the classifier is asked about. Text is untrusted data. */
export interface TriageCandidate {
  accountId: string;
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  /** Short preview from the mail provider; never the full body. */
  snippet: string;
  /** Unix seconds. */
  receivedAt: number;
}

export interface TriageVerdict {
  /** 'none' = leave it for the 15-minute sweep; no label, no push. */
  group: TriageGroup | 'none';
  /** 0..1. */
  confidence: number;
  /** True when a low-confidence answer was downgraded to 'seen' (FR-ETC-5). */
  unsure: boolean;
}

export const NO_VERDICT: TriageVerdict = { group: 'none', confidence: 0, unsure: false };

/**
 * Reads the classifier agent's reply and validates it (FR-ETC-3). Anything that is not a recognised
 * group is 'none': the model's text never reaches a label unchecked. Below `minConfidence`, urgent and
 * drafted are downgraded to 'seen' and marked unsure, so a guess never makes a loud alert (FR-ETC-5).
 */
export function parseVerdict(text: string, minConfidence: number): TriageVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return NO_VERDICT;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    // Not JSON: treated as no verdict. The caller logs it; the sweep still triages the message.
    return NO_VERDICT;
  }
  if (typeof raw !== 'object' || raw === null) return NO_VERDICT;

  const record = raw as Record<string, unknown>; // object checked above
  const group = typeof record.group === 'string' ? record.group.trim().toLowerCase() : '';
  const confidenceRaw = typeof record.confidence === 'number' ? record.confidence : Number.NaN;
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0;

  if (group === 'none') return { group: 'none', confidence, unsure: false };
  if (!(TRIAGE_GROUPS as readonly string[]).includes(group)) return NO_VERDICT;

  const validGroup = group as TriageGroup; // checked against TRIAGE_GROUPS above
  if (confidence < minConfidence && validGroup !== 'seen') {
    return { group: 'seen', confidence, unsure: true };
  }
  return { group: validGroup, confidence, unsure: confidence < minConfidence };
}
