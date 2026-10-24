// Shared email-reply recipient derivation.
//
// Gate C must see the same To/CC set the handler will send (#1815), and the
// email adapter's thread reply follows the same rules (#2273). Keep the three
// CC modes in one place: reply-all (cc omitted), sender-only (cc === ""), and
// an explicit comma-separated list.
//
// Reply-all keeps everyone on the field they were on (#2273):
//   - received message: To = sender + the original's other To; CC = original CC.
//   - message Curia sent: To = the original's To; CC = original CC. A reply goes
//     to the people Curia wrote to, never back to Curia. If that To held only
//     owned mailboxes, the original's CC moves to To.
// Sender-only and an explicit list keep To as the sender (or, for a message
// Curia sent, the original's To) and take CC from the caller.
// Owned mailboxes are dropped from every field.

import { normalizeMailbox } from './reply-recipient-provenance.js';

export interface EmailAddressParticipant {
  email?: string;
}

export interface EmailReplyRecipientSet {
  /**
   * Primary To of the reply: the original sender, or — when the original was
   * sent from an owned mailbox — the first person it was addressed to.
   */
  to: string;
  /** Further To recipients after `to`. Empty when none. */
  additionalTo: string[];
  /** CC addresses after mode-specific filtering and dedup. Empty when none. */
  cc: string[];
  /**
   * True when `to` is the original sender. False when it was taken from the
   * original's recipients, so it is not a header-verified sender (#2071).
   */
  toIsOriginalSender: boolean;
}

/** Trimmed, non-empty addresses from a participant list. */
function addresses(participants: readonly EmailAddressParticipant[] | null | undefined): string[] {
  return (participants ?? [])
    .map((p) => p.email?.trim())
    .filter((addr): addr is string => typeof addr === 'string' && addr.length > 0);
}

/**
 * Derive the reply's To + CC from the original message and the skill's `cc` input.
 *
 * Returns null when the original has no sender, when no address outside the
 * owned mailboxes is left to reply to, or when `cc` is present but not a string
 * (unmodeled input → fail closed for Gate C).
 */
export function deriveEmailReplyRecipientSet(opts: {
  originalFrom: string | undefined;
  originalTo?: readonly EmailAddressParticipant[] | null;
  originalCc?: readonly EmailAddressParticipant[] | null;
  ccInput: unknown;
  /** Owned mailbox addresses, excluded from every field (all accounts, not just primary). */
  selfEmails?: readonly string[];
}): EmailReplyRecipientSet | null {
  const originalFrom = opts.originalFrom?.trim();
  if (!originalFrom) return null;

  const { ccInput } = opts;
  if (ccInput !== undefined && typeof ccInput !== 'string') {
    return null;
  }

  const ownedMailboxes = new Set(
    (opts.selfEmails ?? [])
      .map((addr) => addr.trim())
      .filter((addr) => addr.length > 0)
      .map(normalizeMailbox),
  );
  const isOwned = (addr: string): boolean => ownedMailboxes.has(normalizeMailbox(addr));

  // Case-insensitive dedup across fields, first occurrence wins: an address on
  // To is not repeated on CC.
  const seen = new Set<string>();
  const take = (list: readonly string[]): string[] => list.filter((addr) => {
    const key = addr.toLowerCase();
    if (seen.has(key) || isOwned(addr)) return false;
    seen.add(key);
    return true;
  });

  const originalTo = addresses(opts.originalTo);
  const originalCc = addresses(opts.originalCc);
  const toIsOriginalSender = !isOwned(originalFrom);
  const replyAll = ccInput === undefined;

  let toList: string[];
  let ccFromOriginal: string[] = [];
  if (toIsOriginalSender) {
    // Received message: sender first; reply-all adds the other To and the CC.
    toList = take([originalFrom, ...(replyAll ? originalTo : [])]);
    if (replyAll) ccFromOriginal = take(originalCc);
  } else {
    // Curia sent it: the people it was addressed to. On reply-all, when its To
    // held only owned mailboxes, the CC'd people are who it was really for. The
    // other modes take CC from the caller only, so they get null instead.
    toList = take(originalTo);
    if (replyAll) {
      if (toList.length === 0) toList = take(originalCc);
      else ccFromOriginal = take(originalCc);
    }
  }

  const [to, ...additionalTo] = toList;
  if (!to) return null;

  // Explicit list: as written, minus owned mailboxes and addresses already on To.
  // A reference such as `principal` passes through for Gate C to resolve.
  // Sender-only (""): no CC.
  const cc = typeof ccInput === 'string'
    ? take(ccInput.split(',').map((addr) => addr.trim()).filter((addr) => addr.length > 0))
    : ccFromOriginal;

  return { to, additionalTo, cc, toIsOriginalSender };
}
