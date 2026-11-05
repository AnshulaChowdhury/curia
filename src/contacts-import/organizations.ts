// organizations.ts — groups the farmed people by email domain. Programmatic: no model, no guessing beyond the domain.
//
// A domain counts as an organisation when at least MIN_PEOPLE real people (not role or automated addresses) at it
// appear in the scanned mail and it is not a personal webmail domain (gmail.com, outlook.com, ...). The result is a
// read-only summary for the review step; it never writes a contact or sets a contact's organization field (a guessed
// name could disagree with one already on file and send people to review).

import { classifyEmailSender, PERSONAL_EMAIL_DOMAINS } from '../contacts/contact-service.js';
import type { MailboxCategory } from '../phone-inbox/mailbox-category-store.js';
import type { FarmFactRow } from './farm-store.js';

export const MIN_PEOPLE = 2;

export interface OrganizationSummary {
  domain: string;
  /** Derived from the domain only ("acme.com" → "Acme"). */
  name: string;
  people: number;
  received: number;
  sent: number;
  lastSeen: string;
  /** Work, personal or hybrid, from the categories of the mailboxes it appears in; null when none is known. */
  label: 'work' | 'personal' | 'hybrid' | null;
  mailboxes: string[];
}

export function orgNameFromDomain(domain: string): string {
  const parts = domain.split('.');
  const base = parts.length > 2 && parts[parts.length - 2]!.length <= 3 && parts[parts.length - 1]!.length === 2 ? parts[parts.length - 3]! : (parts[parts.length - 2] ?? parts[0] ?? domain);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function mineOrganizations(
  facts: FarmFactRow[],
  categories: Record<string, MailboxCategory | undefined>,
  limit = 200,
): OrganizationSummary[] {
  interface Acc { people: Set<string>; received: number; sent: number; last: string; boxes: Set<string> }
  const byDomain = new Map<string, Acc>();
  for (const f of facts) {
    if (PERSONAL_EMAIL_DOMAINS.has(f.domain) || classifyEmailSender(f.email) !== 'person') continue;
    const a = byDomain.get(f.domain) ?? { people: new Set<string>(), received: 0, sent: 0, last: f.lastSeen, boxes: new Set<string>() };
    a.people.add(f.email);
    a.received += f.received;
    a.sent += f.sent;
    if (f.lastSeen > a.last) a.last = f.lastSeen;
    a.boxes.add(f.accountId);
    byDomain.set(f.domain, a);
  }
  const out: OrganizationSummary[] = [];
  for (const [domain, a] of byDomain) {
    if (a.people.size < MIN_PEOPLE) continue;
    const cats = new Set([...a.boxes].map((b) => categories[b]).filter((c): c is MailboxCategory => !!c));
    const label = cats.size === 0 ? null : cats.size > 1 ? 'hybrid' : cats.has('WORK') ? 'work' : 'personal';
    out.push({ domain, name: orgNameFromDomain(domain), people: a.people.size, received: a.received, sent: a.sent, lastSeen: a.last, label, mailboxes: [...a.boxes].sort() });
  }
  out.sort((x, y) => y.people - x.people || y.received + y.sent - (x.received + x.sent) || (x.domain < y.domain ? -1 : 1));
  return out.slice(0, limit);
}
