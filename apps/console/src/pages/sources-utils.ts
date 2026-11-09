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
// ---- Mailbox scans (GET/POST /api/contacts/import/farm) ----

export interface FarmMailbox {
  accountId: string;
  eligible: boolean;
  reason?: 'skipped' | 'not_connected' | 'no_category';
  status: 'not_started' | 'running' | 'paused' | 'done' | 'failed';
  running: boolean;
  messagesScanned: number;
  peopleFound: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorKind: string | null;
}

const FARM_NAMES: Record<string, string> = { personal: 'Personal mailbox', moonray: 'Moonray mailbox', 'work-outlook': 'Work Outlook mailbox' };
export function farmName(accountId: string): string {
  return FARM_NAMES[accountId] ?? accountId;
}

const FARM_WHY: Record<string, string> = {
  skipped: 'Skipped for now.',
  not_connected: 'Not connected to Nylas.',
  no_category: 'Waiting for Command Hub (Android Launcher) to report the category.',
};

/** One plain line: where the scan is. Counts only, never addresses. */
export function farmStatusText(m: FarmMailbox): string {
  if (!m.eligible && m.status === 'not_started') return FARM_WHY[m.reason ?? ''] ?? 'Not available.';
  const counts = `${m.messagesScanned.toLocaleString('en-US')} messages read, ${m.peopleFound.toLocaleString('en-US')} people found`;
  if (m.running) return `Scanning… ${counts}.`;
  switch (m.status) {
    case 'not_started': return 'Not scanned yet. Reads the last ten years of mail and keeps only counts.';
    case 'done': return `Done. ${counts}.`;
    case 'paused': return `Paused (the mail provider asked us to slow down). ${counts}. Resume to continue.`;
    case 'failed': return `Stopped by an error (${m.errorKind ?? 'unknown'}). ${counts}. Resume to continue.`;
    default: return counts;
  }
}

/** The button a mailbox offers, or null when none applies. */
export function farmAction(m: FarmMailbox): { label: string; resume: boolean } | null {
  if (!m.eligible || m.running) return null;
  switch (m.status) {
    case 'not_started': return { label: 'Scan last 10 years', resume: false };
    case 'paused':
    case 'failed': return { label: 'Resume scan', resume: true };
    case 'done': return { label: 'Scan again', resume: false };
    default: return null;
  }
}

export const anyFarmRunning = (ms: FarmMailbox[]): boolean => ms.some((m) => m.running);

// ---- Matrix message-activity export (GET/POST /api/contacts/export/*) ----

export interface ExportStatus {
  tokenSet: boolean;
  run: { status: 'requested' | 'running' | 'done' | 'failed'; roomsDone: number; errorKind: string | null; requestedAt: string; finishedAt: string | null } | null;
  partnerRows: number;
}

const num = (n: number): string => n.toLocaleString('en-US');

/** One plain line: where the Matrix export is. Counts only. */
export function exportStatusText(s: ExportStatus): string {
  if (!s.tokenSet) return 'Make the import token first (Settings → API connections).';
  const r = s.run;
  if (!r) return 'Not requested yet. The Mac mini job picks the request up within about five minutes and sends only counts.';
  switch (r.status) {
    case 'requested': return 'Requested. Waiting for the Mac mini job to pick it up (it checks every five minutes).';
    case 'running': return `Running… ${num(r.roomsDone)} chats counted, ${num(s.partnerRows)} people so far.`;
    case 'done':
      return s.partnerRows === 0
        ? `Finished (${num(r.roomsDone)} chats looked at) but no chat partners were found. The bridge accounts may be named differently than expected; check the job's log on the Mac mini.`
        : `Done. ${num(r.roomsDone)} chats counted, ${num(s.partnerRows)} people found.`;
    case 'failed': return `Stopped by an error (${r.errorKind ?? 'unknown'}). ${num(s.partnerRows)} people so far. Request again to continue.`;
    default: return 'Unknown state.';
  }
}

/** The button the export offers, or null when none applies. */
export function exportAction(s: ExportStatus): string | null {
  if (!s.tokenSet) return null;
  const r = s.run;
  if (!r) return 'Request Matrix export';
  if (r.status === 'done') return 'Run again';
  if (r.status === 'failed') return 'Request again';
  return null;
}

export const exportInProgress = (s: ExportStatus | null): boolean => s?.run?.status === 'requested' || s?.run?.status === 'running';
