// sources.ts — the list behind the Contacts page "Sources" drawer: every place the contact import reads people from,
// and whether it will, right now. Pure: the route gathers the inputs, this decides.
//
// Rules (decided by the owner, 2026-11-02):
//   - A mailbox is read only when its Nylas grant is connected AND Command Hub has reported its Work/Personal category.
//     The category is never inferred or edited here; a mailbox without one waits for the phone.
//   - `work-outlook` is skipped for now (the employer blocks Curia from that mailbox).
//   - Addresses are masked in this list; secrets never appear.

import type { ReportedCategory, MailboxCategory } from '../phone-inbox/mailbox-category-store.js';
import type { PhoneInboxAccountId } from '../phone-inbox/phone-inbox-service.js';

/** Shown verbatim in the console while a mailbox has no category from the phone. */
export const WAITING_FOR_PHONE_NOTE = 'waiting for Command Hub (Android Launcher) to report the category';

export type SourceStatus = 'ready' | 'waiting' | 'not_connected' | 'skipped';
export type SourceType = 'mailbox' | 'bridge' | 'google_contacts' | 'apple_contacts';

export interface ImportSource {
  /** Stable key, e.g. `mailbox:moonray` or `bridge:whatsapp`. */
  key: string;
  type: SourceType;
  label: string;
  /** Masked mailbox address (`a***@example.com`), or null when there is none. */
  address: string | null;
  status: SourceStatus;
  /** Work/Personal as reported by Command Hub; null for anything that is not a mailbox, or not yet reported. */
  category: MailboxCategory | null;
  /** ISO-8601, when the phone last reported the category. */
  categoryReportedAt: string | null;
  /** True when the next import would read this source. */
  willImport: boolean;
  /** One plain-language line for the drawer. */
  note: string;
  /** Where to fix it, when the fix lives on another page. */
  linkTo: string | null;
  /** Not known until the weekly pull exists. */
  lastPulledAt: string | null;
  peopleFound: number | null;
}

export interface MailboxInput {
  id: PhoneInboxAccountId;
  address: string | null;
  /** True when the mailbox has a Nylas grant. */
  connected: boolean;
}

export interface BridgeInput {
  id: string;
  label: string;
  hasUrl: boolean;
  hasSecret: boolean;
}

const MAILBOX_LABELS: Record<PhoneInboxAccountId, string> = {
  personal: 'Personal mailbox',
  moonray: 'Moonray mailbox',
  'work-outlook': 'Work Outlook mailbox',
};

/** `anshula@example.com` → `a***@example.com`. Never throws; anything unparseable is hidden entirely. */
export function maskAddress(address: string | null | undefined): string | null {
  const value = (address ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return value ? '***' : null;
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

export function buildSources(input: {
  mailboxes: MailboxInput[];
  categories: ReportedCategory[];
  bridges: BridgeInput[];
}): ImportSource[] {
  const reported = new Map(input.categories.map((c) => [c.accountId, c]));
  const sources: ImportSource[] = [];

  for (const m of input.mailboxes) {
    const cat = reported.get(m.id) ?? null;
    const base = {
      key: `mailbox:${m.id}`,
      type: 'mailbox' as const,
      label: MAILBOX_LABELS[m.id],
      address: maskAddress(m.address),
      category: cat?.category ?? null,
      categoryReportedAt: cat?.reportedAt ?? null,
      lastPulledAt: null,
      peopleFound: null,
    };
    if (m.id === 'work-outlook') {
      sources.push({ ...base, status: 'skipped', willImport: false, linkTo: null, note: 'Skipped for now: the employer blocks Curia from this mailbox.' });
    } else if (!m.connected) {
      sources.push({ ...base, status: 'not_connected', willImport: false, linkTo: '/connections', note: 'Not connected. Add its Nylas grant on API Connections.' });
    } else if (!cat) {
      sources.push({ ...base, status: 'waiting', willImport: false, linkTo: null, note: WAITING_FOR_PHONE_NOTE });
    } else {
      sources.push({ ...base, status: 'ready', willImport: true, linkTo: null, note: `${cat.category === 'WORK' ? 'Work' : 'Personal'}, set on Command Hub.` });
    }
  }

  for (const b of input.bridges) {
    const connected = b.hasUrl && b.hasSecret;
    sources.push({
      key: `bridge:${b.id}`,
      type: 'bridge',
      label: b.label,
      address: null,
      status: connected ? 'ready' : 'not_connected',
      category: null,
      categoryReportedAt: null,
      willImport: connected,
      linkTo: connected ? null : '/connections',
      note: connected ? 'Contact list is read from the bridge.' : 'Not connected. Add its address and secret on API Connections.',
      lastPulledAt: null,
      peopleFound: null,
    });
  }

  sources.push(
    {
      key: 'google_contacts', type: 'google_contacts', label: 'Google Contacts', address: null, status: 'not_connected',
      category: null, categoryReportedAt: null, willImport: false, linkTo: null,
      note: 'Not built yet (a later step).', lastPulledAt: null, peopleFound: null,
    },
    {
      key: 'apple_contacts', type: 'apple_contacts', label: 'Apple Contacts (Mac mini)', address: null, status: 'not_connected',
      category: null, categoryReportedAt: null, willImport: false, linkTo: null,
      note: 'Needs the Mac mini export (not built yet).', lastPulledAt: null, peopleFound: null,
    },
  );

  return sources;
}
