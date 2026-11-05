// farm-reduce.ts — turns scanned messages into per-person counts. Pure; no I/O.
//
// Rules (programmatic, no model):
//   - the mailbox's own address is never counted;
//   - automated senders (noreply@, notifications@, ...) are skipped, using the same classifier as the rest of Curia;
//   - mail in spam, trash or drafts is ignored;
//   - a message to more than MAX_RECIPIENTS people is a mailing list, not a conversation: only its sender is counted;
//   - mail the mailbox owner sent counts as "sent" for each To/Cc recipient; mail from someone else counts as
//     "received" for the sender, and "copied" for the other To/Cc people.

import { classifyEmailSender } from '../contacts/contact-service.js';
import type { ScannedMessage } from '../phone-inbox/nylas-mailbox.js';
import { normalizeEmail } from './normalize.js';

export const MAX_RECIPIENTS = 20;
const IGNORED_FOLDER_NAMES = new Set(['spam', 'junk', 'junk email', 'trash', 'deleted items', 'deleted', 'draft', 'drafts']);

export interface FarmDelta {
  email: string;
  domain: string;
  name?: string;
  received: number;
  sent: number;
  copied: number;
  /** Epoch seconds. */
  first: number;
  last: number;
}

export function ignoredFolderIds(names: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const [id, name] of names) if (IGNORED_FOLDER_NAMES.has(name.trim().toLowerCase()) || IGNORED_FOLDER_NAMES.has(id.toLowerCase())) ids.add(id);
  return ids;
}

export function reduceMessages(messages: ScannedMessage[], ownAddress: string | null, ignored: Set<string>): Map<string, FarmDelta> {
  const own = ownAddress ? normalizeEmail(ownAddress) : null;
  const out = new Map<string, FarmDelta>();
  const touch = (p: { name?: string; email: string }, kind: 'received' | 'sent' | 'copied', date: number): void => {
    const email = normalizeEmail(p.email);
    if (!email || email === own || classifyEmailSender(email) === 'automated') return;
    const row = out.get(email) ?? { email, domain: email.slice(email.indexOf('@') + 1), received: 0, sent: 0, copied: 0, first: date, last: date };
    row[kind] += 1;
    if (date > 0) {
      row.first = row.first > 0 ? Math.min(row.first, date) : date;
      row.last = Math.max(row.last, date);
    }
    // Keep the longest real-looking name seen (a bare address is not a name).
    if (p.name && !p.name.includes('@') && (row.name?.length ?? 0) < p.name.length) row.name = p.name.trim();
    out.set(email, row);
  };

  for (const m of messages) {
    if (m.folders.some((f) => ignored.has(f))) continue;
    const sender = m.from[0];
    const fromOwn = !!own && !!sender && normalizeEmail(sender.email) === own;
    const others = [...m.to, ...m.cc];
    const bulk = others.length > MAX_RECIPIENTS;
    if (fromOwn) {
      if (!bulk) for (const r of others) touch(r, 'sent', m.date);
    } else {
      if (sender) touch(sender, 'received', m.date);
      if (!bulk) for (const r of others) touch(r, 'copied', m.date);
    }
  }
  return out;
}
