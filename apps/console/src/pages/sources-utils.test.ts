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

import { applyOutcomeText, applyPrompt, reviewReasonText, type PreviewResult } from './sources-utils.js';

const preview = (totals: Partial<PreviewResult['totals']>): PreviewResult => ({
  runId: 'pull-a-00000000', createdAt: '', totals: { people: 0, create: 0, attach: 0, review: 0, ...totals },
  reviewReasons: {}, sources: [], droppedNoName: 0, sample: { create: [], attach: [], review: [] },
});

describe('preview and apply wording', () => {
  it('says exactly what Apply will do and that nothing is deleted', () => {
    expect(applyPrompt(preview({ create: 3, attach: 2, review: 1 }))).toBe(
      'Add 3 new people as unknown, link 2 to existing contacts; 1 need review and will be left alone. Nothing is deleted or overwritten.');
    expect(applyPrompt(preview({ create: 1 }))).toBe('Add 1 new person as unknown, link 0 to existing contacts. Nothing is deleted or overwritten.');
  });

  it('reports the outcome, and tells the owner when some could not be saved', () => {
    expect(applyOutcomeText({ runId: 'r', totals: { created: 2, attached: 1, skipped: 0, failed: 0 } })).toBe('Added 2, linked 1, left 0 alone.');
    expect(applyOutcomeText({ runId: 'r', totals: { created: 2, attached: 1, skipped: 0, failed: 3 } })).toContain('3 could not be saved');
  });

  it('explains review reasons in plain words and passes unknown codes through', () => {
    expect(reviewReasonText('protected_contact')).toContain('you, an agent');
    expect(reviewReasonText('brand_new_code')).toBe('brand_new_code');
  });
});

import { farmAction, farmStatusText, anyFarmRunning, type FarmMailbox } from './sources-utils.js';

const farm = (over: Partial<FarmMailbox>): FarmMailbox => ({
  accountId: 'moonray', eligible: true, status: 'not_started', running: false, messagesScanned: 0, peopleFound: 0,
  startedAt: null, finishedAt: null, errorKind: null, ...over,
});

describe('mailbox scan text and actions', () => {
  it('explains why an ineligible mailbox cannot be scanned', () => {
    expect(farmStatusText(farm({ eligible: false, reason: 'no_category' }))).toContain('Command Hub (Android Launcher)');
    expect(farmStatusText(farm({ eligible: false, reason: 'skipped' }))).toBe('Skipped for now.');
    expect(farmAction(farm({ eligible: false, reason: 'skipped' }))).toBeNull();
  });
  it('offers start, resume or scan again by state, and nothing while running', () => {
    expect(farmAction(farm({}))).toEqual({ label: 'Scan last 10 years', resume: false });
    expect(farmAction(farm({ status: 'paused' }))).toEqual({ label: 'Resume scan', resume: true });
    expect(farmAction(farm({ status: 'failed' }))).toEqual({ label: 'Resume scan', resume: true });
    expect(farmAction(farm({ status: 'done' }))).toEqual({ label: 'Scan again', resume: false });
    expect(farmAction(farm({ status: 'running', running: true }))).toBeNull();
  });
  it('shows counts while running and when done', () => {
    expect(farmStatusText(farm({ status: 'running', running: true, messagesScanned: 12000, peopleFound: 340 }))).toBe('Scanning… 12,000 messages read, 340 people found.');
    expect(farmStatusText(farm({ status: 'done', messagesScanned: 5, peopleFound: 2 }))).toBe('Done. 5 messages read, 2 people found.');
    expect(farmStatusText(farm({ status: 'failed', errorKind: 'NylasMailboxError' }))).toContain('NylasMailboxError');
  });
  it('detects a running scan so the drawer keeps polling', () => {
    expect(anyFarmRunning([farm({}), farm({ running: true })])).toBe(true);
    expect(anyFarmRunning([farm({})])).toBe(false);
  });
});
