// cleanup-service.ts — undoes the part of an import that should never have been: contacts the import created from a
// mailbox for people you have never written to (newsletters, notifications, strangers).
//
// A contact is removed only when ALL of these hold, so anything a person touched is kept:
//   - the import created it (it is in an applied batch's "created" list), through a mailbox source only
//   - no scanned mailbox shows mail SENT to its address
//   - tier is still `unknown`, it is a plain person/automated contact (not the principal, an agent or system)
//   - one identity only (its email), no notes, role, title or organisation, and no work / personal decision
// "No sent mail seen" only proves you never wrote to someone once the scan has read the whole mailbox. So:
//   - every mailbox the contact came from has a finished scan  -> removable
//   - otherwise, only when the address is clearly automated (no-reply, newsletter, bulk-mail domain) -> removable
//   - otherwise it is held back ("held"), and is reconsidered once the scans finish
// It does not run while a scan is actively running (the counts are moving).
// Preview counts; Apply re-checks, and refuses if the count is no longer the one that was reviewed.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import { maskAddress } from './sources.js';
import { classifyEmailSender } from '../contacts/contact-service.js';

export interface CleanupCandidate {
  contactId: string; displayName: string; email: string;
  /** Mailbox account ids the contact was imported from (from `mailbox:<account>:<email>` source keys). */
  accounts: string[];
}

const BULK_LOCAL_RE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|bounces?|newsletters?|digest|mailer|notifications?|unsubscribe|marketing|promo(tions?)?|offers?|deals?|receipts?|invoices?|billing|orders?|alerts?|updates?|news|info|hello|team|support|admin|service|campaigns?|mailings?)([-_.+0-9]|$)/i;
const BULK_DOMAIN_RE = /(^|\.)(substack\.com|mailchimp\.com|sendgrid\.net|mailgun\.org|constantcontact\.com|hubspotemail\.net|beehiiv\.com|convertkit\.com|klaviyomail\.com)$/i;
const BULK_SUBDOMAIN_RE = /^(mail|email|em|e|news|newsletter|notifications?|mg|send|bounce|reply|info|updates?|marketing|promo|t|click|go)\d*\./i;

/** True only for addresses that are plainly machine- or marketing-sent; a real person's address must not match. */
export function looksAutomated(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (classifyEmailSender(email) === 'automated') return true;
  return BULK_LOCAL_RE.test(local) || BULK_DOMAIN_RE.test(domain) || BULK_SUBDOMAIN_RE.test(domain);
}

export interface CleanupStore {
  findOneWayImports(limit: number): Promise<CleanupCandidate[]>;
}

export const MAX_CLEANUP = 20_000;

export class PgCleanupStore implements CleanupStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async findOneWayImports(limit: number): Promise<CleanupCandidate[]> {
    const r = await this.pool.query<{ id: string; display_name: string; email: string; accounts: string[] }>(
      `SELECT c.id, c.display_name, i.channel_identifier AS email,
               ARRAY(SELECT DISTINCT split_part(s.source_key, ':', 2) FROM contact_import_sources s
                      WHERE s.contact_id = c.id AND s.source_key LIKE 'mailbox:%') AS accounts
         FROM contacts c
         JOIN contact_channel_identities i ON i.contact_id = c.id AND i.channel = 'email'
        WHERE c.tier = 'unknown'
          AND c.system_role IS NULL
          AND c.kind IN ('person', 'automated')
          AND c.notes IS NULL AND c.role IS NULL AND c.title IS NULL AND c.organization IS NULL
          AND (SELECT count(*) FROM contact_channel_identities x WHERE x.contact_id = c.id) = 1
          AND EXISTS (SELECT 1 FROM contact_import_sources s WHERE s.contact_id = c.id AND s.source_key LIKE 'mailbox:%')
          AND NOT EXISTS (SELECT 1 FROM contact_import_sources s WHERE s.contact_id = c.id AND s.source_key NOT LIKE 'mailbox:%')
          AND NOT EXISTS (SELECT 1 FROM contact_import_labels l WHERE l.contact_id = c.id AND l.label IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM contact_import_batches b, jsonb_array_elements(COALESCE(b.result->'outcomes', '[]'::jsonb)) o
             WHERE b.status = 'applied' AND o->>'outcome' = 'created' AND o->>'contactId' = c.id::text)
          AND NOT EXISTS (SELECT 1 FROM contact_farm_facts f WHERE lower(f.email) = lower(i.channel_identifier) AND f.sent > 0)
        ORDER BY c.created_at
        LIMIT $1`,
      [limit]);
    return r.rows.map((x) => ({ contactId: x.id, displayName: x.display_name, email: x.email, accounts: x.accounts }));
  }
}

export class CleanupError extends Error {
  constructor(public readonly code: 'scans_running' | 'count_changed', message: string) {
    super(message);
    this.name = 'CleanupError';
  }
}

export interface CleanupPreview {
  total: number;
  sample: { name: string; identifier: string }[];
  /** Mailboxes whose scan stopped before the end: their one-way senders may include people you did write to. */
  unfinished: string[];
  /** People-looking contacts kept for now because a scan they came from has not finished. They come back up once it does. */
  held: number;
}

export interface ScanState { running: boolean; unfinished: string[] }
export interface CleanupResult { removed: number; kept: number }

export class ImportCleanupService {
  constructor(
    private readonly store: CleanupStore,
    private readonly contacts: { deleteContact(id: string): Promise<void> },
    private readonly scanState: () => Promise<ScanState>,
    private readonly logger: Logger,
  ) {}

  private async candidates(): Promise<{ found: CleanupCandidate[]; unfinished: string[]; held: number }> {
    const state = await this.scanState();
    if (state.running) {
      throw new CleanupError('scans_running', 'A mailbox scan is running right now, so the counts are still changing. Wait for it to stop, then try again.');
    }
    const open = new Set(state.unfinished);
    const all = await this.store.findOneWayImports(MAX_CLEANUP);
    // Proven one-way: every mailbox it came from was fully scanned (and a contact with no known mailbox is never proven).
    const found = all.filter((c) => (c.accounts.length > 0 && c.accounts.every((a) => !open.has(a))) || looksAutomated(c.email));
    return { found, unfinished: state.unfinished, held: all.length - found.length };
  }

  async preview(): Promise<CleanupPreview> {
    const { found, unfinished, held } = await this.candidates();
    return { total: found.length, sample: found.slice(0, 8).map((c) => ({ name: c.displayName, identifier: maskAddress(c.email) ?? '' })), unfinished, held };
  }

  async apply(expected: number): Promise<CleanupResult> {
    const { found } = await this.candidates();
    if (found.length !== expected) {
      throw new CleanupError('count_changed', `The list changed since the preview (${found.length} now, ${expected} then). Preview again.`);
    }
    let removed = 0;
    let kept = 0;
    for (const c of found) {
      try {
        await this.contacts.deleteContact(c.contactId);
        removed += 1;
      } catch (err) {
        // Something still points at it (for example a held message), so it is not ours to remove.
        kept += 1;
        this.logger.warn({ errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-import: cleanup kept a contact that is still referenced');
      }
    }
    this.logger.info({ removed, kept }, 'contacts-import: cleanup applied');
    return { removed, kept };
  }
}
