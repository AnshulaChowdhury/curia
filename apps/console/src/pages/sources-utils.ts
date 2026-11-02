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
