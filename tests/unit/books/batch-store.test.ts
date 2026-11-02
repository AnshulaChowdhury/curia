import { describe, it, expect } from 'vitest';
import { applyEdits, approvalBlocker, BatchError, validateEdits, validatePush } from '../../../src/books/batch-store.js';

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
