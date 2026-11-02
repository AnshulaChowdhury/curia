import { describe, it, expect } from 'vitest';
import { applyEdits, approvalBlocker, BatchError, validateEdits, validatePush, toReviewCard } from '../../../src/books/batch-store.js';

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, amount: '-12.00', date: '2026-11-02', description: 'COFFEE', ...extra });

describe('validatePush', () => {
  it('accepts a batch and keeps unknown keys as pushed', () => {
    const out = validatePush('abcdef0123456789', [row('r1', { flags: [{ kind: 'large_amount' }], anything: { nested: true } })], { status: 'ready' });
    expect(out.rows[0]).toMatchObject({ id: 'r1', anything: { nested: true } });
    expect(out.report).toEqual({ status: 'ready' });
  });

  it('treats a missing report as empty', () => {
    expect(validatePush('abcdef0123456789', [], undefined).report).toEqual({});
  });

  it.each([
    ['a batch id that is not hex', 'XYZ-not-hex!', [row('r1')]],
    ['a batch id that is too short', 'abc', [row('r1')]],
    ['rows that are not a list', 'abcdef0123456789', 'nope'],
    ['a row without an id', 'abcdef0123456789', [{ amount: '1', date: 'd', description: 'x' }]],
    ['an id that is too long', 'abcdef0123456789', [row('x'.repeat(101))]],
    ['a row without a description', 'abcdef0123456789', [{ id: 'r', amount: '1', date: 'd' }]],
    ['a row with a numeric amount', 'abcdef0123456789', [{ ...row('r'), amount: 12 }]],
    ['the same row id twice', 'abcdef0123456789', [row('r1'), row('r1')]],
  ])('rejects %s', (_label, id, rows) => {
    expect(() => validatePush(id, rows, {})).toThrow(BatchError);
  });

  it('rejects more than 2000 rows and anything over 2 MB', () => {
    const many = Array.from({ length: 2001 }, (_, i) => row(`r${i}`));
    expect(() => validatePush('abcdef0123456789', many, {})).toThrow(/at most 2000/);
    expect(() => validatePush('abcdef0123456789', [row('r1', { blob: 'x'.repeat(2 * 1024 * 1024) })], {})).toThrow(/2 MB/);
    expect(() => validatePush('abcdef0123456789', [row('r1')], [1, 2])).toThrow(BatchError);
  });
});

describe('validateEdits', () => {
  it('allows only the five editable fields, as short text', () => {
    expect(validateEdits({ category: 'Bank charges', payee: ' Canada Post ' })).toEqual({ category: 'Bank charges', payee: 'Canada Post' });
  });

  it('null or empty removes an edit', () => {
    expect(validateEdits({ class: null, location: '', payee: '   ' })).toEqual({ class: null, location: null, payee: null });
  });

  it.each([
    ['an unknown field', { amount: '5' }],
    ['the description', { description: 'x' }],
    ['a non-string value', { category: 7 }],
    ['text over 200 characters', { category: 'x'.repeat(201) }],
    ['edits that are not an object', ['category']],
  ])('rejects %s', (_label, edits) => {
    expect(() => validateEdits(edits)).toThrow(BatchError);
  });
});

describe('applyEdits', () => {
  it('adds, replaces and removes without touching other edits', () => {
    expect(applyEdits({ category: 'A', payee: 'P' }, { category: 'B', payee: null, class: 'Operations' })).toEqual({ category: 'B', class: 'Operations' });
  });
});

describe('approvalBlocker', () => {
  const flagged = (kind: string, category?: string) => ({ id: 'r1', category, flags: [{ kind }] });

  it('blocks a row with an open blocking flag and no category', () => {
    for (const kind of ['needs_category', 'row_error', 'unpaired_transfer', 'amount_differs', 'date_differs']) {
      expect(approvalBlocker(flagged(kind))).toMatch(/choose a category/);
      expect(approvalBlocker(flagged(kind, '  '))).not.toBeNull();
    }
  });

  it('lets the row through once a category is chosen', () => {
    expect(approvalBlocker(flagged('needs_category', 'Bank charges'))).toBeNull();
  });

  it('ignores flags that are only a heads-up, and rows with no flags', () => {
    expect(approvalBlocker(flagged('large_amount'))).toBeNull();
    expect(approvalBlocker({ id: 'r1', flags: [] })).toBeNull();
    expect(approvalBlocker({ id: 'r1' })).toBeNull();
    expect(approvalBlocker({ id: 'r1', flags: 'not a list' })).toBeNull();
  });
});

describe('toReviewCard', () => {
  it('shapes a row for the phone: bank text capped and cleaned, account in words, edits already merged', () => {
    const card = toReviewCard('abcdef1234567890', 'r1', {
      account: 'rbc-chequing-4530', date: '2026-11-02', amount: '-12.00', description: `  SHOP\u0000PY\n${'X'.repeat(300)}`,
      category: 'Bank charges', category_source: 'Rule', tax_code: 'Exempt', location: 'Krisette and Co.',
      flags: [{ kind: 'large_amount', message: 'over $2500: needs a note' }],
    }, null);
    expect(card).toMatchObject({ id: 'r1', batchId: 'abcdef12', date: '2026-11-02', amount: '-12.00', account: 'RBC chequing', category: 'Bank charges', categorySource: 'Rule', taxCode: 'Exempt', location: 'Krisette and Co.' });
    expect(card.description.length).toBe(120);
    expect(card.description).not.toMatch(/[\u0000-\u001f]/);
    expect(card.reasons).toEqual(['over $2500: needs a note']);
    expect(JSON.stringify(card)).not.toContain('4530');
  });

  it('explains why in plain words: no category, waiting for approval, or what went wrong when posting', () => {
    expect(toReviewCard('b', 'r', { description: 'X' }, null).reasons).toEqual(['Needs a category']);
    expect(toReviewCard('b', 'r', { description: 'X', category: 'Sales' }, null).reasons).toEqual(['Waiting for your approval']);
    expect(toReviewCard('b', 'r', { category: 'Sales' }, { status: 'failed', message: 'Account is missing' }).reasons).toEqual(['Could not be posted: Account is missing']);
    expect(toReviewCard('b', 'r', { category: 'Sales' }, { status: 'manual', message: 'enter it by hand' }).reasons).toEqual(['Has to be entered by hand: enter it by hand']);
  });

  it('keeps at most three reasons and tolerates missing or odd fields', () => {
    const flags = [1, 2, 3, 4, 5].map(n => ({ kind: 'k', message: `reason ${n}` }));
    expect(toReviewCard('b', 'r', { flags }, null).reasons).toHaveLength(3);
    const odd = toReviewCard('b', 'r', { flags: 'nope', amount: 5, date: null, account: undefined }, null);
    expect(odd).toMatchObject({ amount: '', date: '', account: 'bank' });
  });
});
