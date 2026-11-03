// sources-utils.ts — types and wording for the Contacts page "Sources" drawer.
// Mirrors GET /api/contacts/import/sources (src/channels/http/routes/contacts-sources.ts).

export type SourceStatus = 'ready' | 'waiting' | 'not_connected' | 'skipped';

export interface ImportSourceRow {
  key: string;
  type: 'mailbox' | 'bridge' | 'google_contacts' | 'apple_contacts';
  label: string;
  /** Already masked by the server (`a***@example.com`). */
  address: string | null;
  status: SourceStatus;
  category: 'WORK' | 'PERSONAL' | null;
  categoryReportedAt: string | null;
  willImport: boolean;
  note: string;
  linkTo: string | null;
  lastPulledAt: string | null;
  peopleFound: number | null;
}

export const STATUS_LABEL: Record<SourceStatus, string> = {
  ready: 'Will import',
  waiting: 'Waiting',
  not_connected: 'Not connected',
  skipped: 'Skipped',
};

/** "Work" / "Personal" for a reported mailbox category; null when there is nothing to show. */
export function categoryLabel(category: ImportSourceRow['category']): string | null {
  if (category === 'WORK') return 'Work';
  if (category === 'PERSONAL') return 'Personal';
  return null;
}

/** One line of counts for the top of the drawer, e.g. "2 of 6 sources will import". */
export function sourcesSummary(rows: ImportSourceRow[]): string {
  const ready = rows.filter(r => r.willImport).length;
  return `${ready} of ${rows.length} sources will import`;
}

// ---- Preview and Apply (POST /api/contacts/import/preview and /apply) ----

export interface PreviewSampleRow { name: string; identifier: string }

export interface PreviewResult {
  runId: string;
  createdAt: string;
  totals: { people: number; create: number; attach: number; review: number };
  reviewReasons: Record<string, number>;
  sources: { sourceId: string; label: string; ok: boolean; message: string; read: number; usable: number }[];
  droppedNoName: number;
  sample: { create: PreviewSampleRow[]; attach: PreviewSampleRow[]; review: PreviewSampleRow[] };
}

export interface ApplyResult {
  runId: string;
  totals: { created: number; attached: number; skipped: number; failed: number };
}

const REASON_TEXT: Record<string, string> = {
  invalid_person: 'missing a name or id',
  no_usable_identifier: 'no usable phone or email',
  duplicate_in_batch: 'listed twice',
  identifiers_span_contacts: 'its numbers or emails belong to different existing contacts',
  protected_contact: 'matches you, an agent or a system contact',
  source_key_conflict: 'already linked to a different contact',
  field_differs: 'a detail differs from what is on file',
  changed_since_dry_run: 'changed since the preview',
};

/** Plain-language reason a person was set aside for review; unknown codes are shown as they are. */
export function reviewReasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}

/** What Apply will do, in one sentence the owner reads before pressing it. */
export function applyPrompt(p: PreviewResult): string {
  const parts = [
    `Add ${p.totals.create} new ${p.totals.create === 1 ? 'person' : 'people'} as unknown`,
    `link ${p.totals.attach} to existing contacts`,
  ];
  const skip = p.totals.review > 0 ? `; ${p.totals.review} need review and will be left alone` : '';
  return `${parts.join(', ')}${skip}. Nothing is deleted or overwritten.`;
}

/** The outcome after Apply, one sentence. */
export function applyOutcomeText(r: ApplyResult): string {
  const t = r.totals;
  const base = `Added ${t.created}, linked ${t.attached}, left ${t.skipped} alone`;
  return t.failed > 0 ? `${base}. ${t.failed} could not be saved; run the preview again to retry.` : `${base}.`;
}

// ---- Organisations found in scanned mail (GET /api/contacts/import/organizations) ----

export interface OrganizationRow {
  domain: string;
  name: string;
  people: number;
  received: number;
  sent: number;
  lastSeen: string;
  label: 'work' | 'personal' | 'hybrid' | null;
  mailboxes: string[];
}

/** "12 people · 340 emails in, 120 out · work" */
export function orgLine(o: OrganizationRow): string {
  const label = o.label ? ` · ${o.label}` : '';
  return `${o.people} ${o.people === 1 ? 'person' : 'people'} · ${o.received.toLocaleString('en-US')} in, ${o.sent.toLocaleString('en-US')} out${label}`;
}
