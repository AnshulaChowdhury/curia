// types.ts — shared shapes for real-time inbox triage (the watcher, the classifier agent and the push).
//
// Requirements: MVOS business_analysis/email-triage-requirements.md (FR-ETW, FR-ETC, FR-ETP).

import { groupOfLabel } from '../phone-inbox/phone-inbox-service.js';

/**
 * The groups the classifier can pick. The keys are internal (the phone contract still says urgent / drafted /
 * seen); the Gmail label text is in TRIAGE_LABELS.
 */
export const TRIAGE_GROUPS = ['urgent', 'drafted', 'seen', 'newsletter', 'spam'] as const;
export type TriageGroup = (typeof TRIAGE_GROUPS)[number];

/** The groups that wake the phone and show on its Home screen. Newsletter and spam are labelled and marked read only. */
export const PUSH_GROUPS = ['urgent', 'drafted', 'seen'] as const;
export type PushGroup = (typeof PUSH_GROUPS)[number];

export function isPushGroup(group: TriageGroup): group is PushGroup {
  return (PUSH_GROUPS as readonly string[]).includes(group);
}

/** Groups whose mail is marked read as well as labelled, so it stops counting as unread. */
export function marksRead(group: TriageGroup): boolean {
  return group === 'newsletter' || group === 'spam';
}

/**
 * Gmail label text per group. "Spam" itself is a Gmail system label (user labels cannot reuse system names, and
 * applying the real one would move the mail into the Spam folder), so that label is "Likely spam".
 */
export const TRIAGE_LABELS: Record<TriageGroup, string> = {
  urgent: 'Urgent',
  drafted: 'Needs a reply',
  seen: 'FYI, no action needed',
  newsletter: 'Newsletter',
  spam: 'Likely spam',
};

/**
 * Which group a label name belongs to, ignoring emoji, punctuation and case. Also recognises the previous names
 * ("🚨 Urgent", "✍️ Drafted", "📌 Seen") so mail tagged before the rename still counts as tagged. The bare word
 * "spam" is deliberately not matched: that is Gmail's own folder.
 */
export function triageGroupOfLabel(name: string): TriageGroup | null {
  const phoneGroup = groupOfLabel(name);
  if (phoneGroup) return phoneGroup;
  const letters = name.replace(/[^\p{L}]/gu, '').toLowerCase();
  if (letters === 'likelyspam') return 'spam';
  if (letters === 'newsletter') return 'newsletter';
  return null;
}

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
  /** 'none' = no label and no push; the 15-minute sweep still sees it. */
  group: TriageGroup | 'none';
  /** 0..1. */
  confidence: number;
  /** True when a low-confidence answer was downgraded to 'seen' (FR-ETC-5). */
  unsure: boolean;
}

export const NO_VERDICT: TriageVerdict = { group: 'none', confidence: 0, unsure: false };

/**
 * Reads the classifier agent's reply and validates it (FR-ETC-3). Anything that is not a recognised
 * group is 'none': the model's text never reaches a label unchecked. Below `minConfidence`, every group except
 * 'seen' is downgraded to 'seen' and marked unsure: a guess never makes a loud alert, and a guess that something is
 * spam or a newsletter never marks real mail read and hides it (FR-ETC-5).
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
