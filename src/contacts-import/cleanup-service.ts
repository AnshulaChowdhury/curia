// cleanup-service.ts — undoes the part of an import that should never have been: contacts the import created from a
// mailbox for people you have never written to (newsletters, notifications, strangers).
//
// A contact is removed only when ALL of these hold, so anything a person touched is kept:
//   - the import created it (it is in an applied batch's "created" list), through a mailbox source only
//   - no scanned mailbox shows mail SENT to its address
//   - tier is still `unknown`, it is a plain person/automated contact (not the principal, an agent or system)
//   - one identity only (its email), no notes, role, title or organisation, and no work / personal decision
// It does not run while a scan is actively running (the counts are moving). A scan that stopped part-way is allowed, and
// the preview says so: a person you wrote to whose mail the scan has not reached yet looks like a one-way sender.
// Preview counts; Apply re-checks, and refuses if the count is no longer the one that was reviewed.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import { maskAddress } from './sources.js';

export interface CleanupCandidate { contactId: string; displayName: string; email: string }

export interface CleanupStore {
  findOneWayImports(limit: number): Promise<CleanupCandidate[]>;
}

export const MAX_CLEANUP = 20_000;

export class PgCleanupStore implements CleanupStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async findOneWayImports(limit: number): Promise<CleanupCandidate[]> {
    const r = await this.pool.query<{ id: string; display_name: string; email: string }>(
      `SELECT c.id, c.display_name, i.channel_identifier AS email
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
    return r.rows.map((x) => ({ contactId: x.id, displayName: x.display_name, email: x.email }));
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

  private async candidates(): Promise<{ found: CleanupCandidate[]; unfinished: string[] }> {
    const state = await this.scanState();
    if (state.running) {
      throw new CleanupError('scans_running', 'A mailbox scan is running right now, so the counts are still changing. Wait for it to stop, then try again.');
    }
    return { found: await this.store.findOneWayImports(MAX_CLEANUP), unfinished: state.unfinished };
  }

  async preview(): Promise<CleanupPreview> {
    const { found, unfinished } = await this.candidates();
    return { total: found.length, sample: found.slice(0, 8).map((c) => ({ name: c.displayName, identifier: maskAddress(c.email) ?? '' })), unfinished };
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
