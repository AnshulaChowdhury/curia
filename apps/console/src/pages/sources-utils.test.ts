import { describe, it, expect } from 'vitest';
import { STATUS_LABEL, categoryLabel, sourcesSummary, type ImportSourceRow } from './sources-utils.js';

const row = (over: Partial<ImportSourceRow>): ImportSourceRow => ({
  key: 'k', type: 'mailbox', label: 'L', address: null, status: 'ready', category: null, categoryReportedAt: null,
  willImport: true, note: '', linkTo: null, lastPulledAt: null, peopleFound: null, ...over,
});

describe('sources-utils', () => {
  it('words the category as the owner sees it', () => {
    expect(categoryLabel('WORK')).toBe('Work');
    expect(categoryLabel('PERSONAL')).toBe('Personal');
    expect(categoryLabel(null)).toBeNull();
  });

  it('has a label for every status', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(['not_connected', 'ready', 'skipped', 'waiting']);
  });

  it('counts only the sources that will import', () => {
    const rows = [row({}), row({ willImport: false, status: 'waiting' }), row({ willImport: false, status: 'skipped' })];
    expect(sourcesSummary(rows)).toBe('1 of 3 sources will import');
    expect(sourcesSummary([])).toBe('0 of 0 sources will import');
  });
});
