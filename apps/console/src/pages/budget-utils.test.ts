import { describe, it, expect } from 'vitest';
import {
  shiftMonth, isMonth, formatCents, parseDollarsToCents, centsToDollarInput, statusFor, spentIn,
  rolloverInto, buildRows, totalsOf, needsYou, barPercent, buildMoneySummary, validateDraft,
} from './budget-utils.js';
import { FIXTURE_CATEGORIES, FIXTURE_TXNS, FIXTURE_MONTH } from './budget-fixtures.js';
import { stateForStatus } from './budget-data.js';

describe('months', () => {
  it('shifts across year boundaries', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', -12)).toBe('2025-11');
  });
  it('validates month strings', () => {
    expect(isMonth('2026-11')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('')).toBe(false);
  });
});

describe('money', () => {
  it('formats integer cents including negatives', () => {
    expect(formatCents(12345, 'CAD', 'en-CA')).toBe('$123.45');
    expect(formatCents(-5, 'CAD', 'en-CA')).toBe('-$0.05');
  });
  it('parses typed dollars to cents without float error', () => {
    expect(parseDollarsToCents('12')).toBe(1200);
    expect(parseDollarsToCents('12.5')).toBe(1250);
    expect(parseDollarsToCents('$1,200.05')).toBe(120005);
    expect(parseDollarsToCents('0.29')).toBe(29);
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('-3')).toBeNull();
    expect(parseDollarsToCents('1.234')).toBeNull();
  });
  it('round-trips for the edit input', () => {
    expect(centsToDollarInput(25000)).toBe('250.00');
    expect(centsToDollarInput(5)).toBe('0.05');
  });
});

describe('status', () => {
  it('splits under, near and over', () => {
    expect(statusFor(7900, 10000)).toBe('under');
    expect(statusFor(8000, 10000)).toBe('near');
    expect(statusFor(10000, 10000)).toBe('near');
    expect(statusFor(10001, 10000)).toBe('over');
  });
  it('treats spending against a zero budget as over', () => {
    expect(statusFor(1, 0)).toBe('over');
    expect(statusFor(0, 0)).toBe('under');
  });
  it('clamps the bar and handles infinity', () => {
    expect(barPercent(0.5)).toBe(50);
    expect(barPercent(3)).toBe(100);
    expect(barPercent(Infinity)).toBe(100);
  });
});

describe('fixture month', () => {
  const rows = buildRows(FIXTURE_CATEGORIES, FIXTURE_TXNS, FIXTURE_MONTH);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  it('sums money out per category and ignores other months', () => {
    expect(spentIn(FIXTURE_TXNS, 'cat-groceries', FIXTURE_MONTH)).toBe(61000);
    expect(spentIn(FIXTURE_TXNS, 'cat-groceries', '2026-10')).toBe(48000);
  });
  it('flags groceries over and transport near', () => {
    expect(byId['cat-groceries']!.status).toBe('over');
    expect(byId['cat-transport']!.status).toBe('near');
    expect(byId['cat-home']!.status).toBe('under');
  });
  it('carries unspent rollover only for opted-in categories', () => {
    const dining = FIXTURE_CATEGORIES.find(c => c.id === 'cat-dining')!;
    const groceries = FIXTURE_CATEGORIES.find(c => c.id === 'cat-groceries')!;
    expect(rolloverInto(dining, FIXTURE_TXNS, FIXTURE_MONTH)).toBe(10000);
    expect(rolloverInto(groceries, FIXTURE_TXNS, FIXTURE_MONTH)).toBe(0);
    expect(byId['cat-dining']!.budgetCents).toBe(35000);
  });
  it('totals the rows', () => {
    const t = totalsOf(rows);
    expect(t.spentCents).toBe(rows.reduce((a, r) => a + r.spentCents, 0));
  });
  it('lists what needs the owner', () => {
    const labels = needsYou(rows, FIXTURE_TXNS, FIXTURE_MONTH).map(n => n.kind);
    expect(labels).toContain('uncategorised');
    expect(labels).toContain('guess');
    expect(labels).toContain('over_budget');
  });
  it('builds a compact summary of the top three', () => {
    const s = buildMoneySummary(FIXTURE_CATEGORIES, FIXTURE_TXNS, FIXTURE_MONTH);
    expect(s.top).toHaveLength(3);
    expect(s.top[0]!.id).toBe('cat-groceries');
    expect(s.needsYouCount).toBeGreaterThan(0);
  });
});

describe('validateDraft', () => {
  it('rejects blank, duplicate and bad amounts', () => {
    expect(validateDraft({ name: ' ', amount: '10', rollover: false }, FIXTURE_CATEGORIES, null).errors.name).toBeTruthy();
    expect(validateDraft({ name: 'groceries', amount: '10', rollover: false }, FIXTURE_CATEGORIES, null).errors.name).toBeTruthy();
    expect(validateDraft({ name: 'New', amount: 'x', rollover: false }, FIXTURE_CATEGORIES, null).errors.amount).toBeTruthy();
  });
  it('allows keeping the same name while editing', () => {
    const r = validateDraft({ name: 'Groceries', amount: '650', rollover: true }, FIXTURE_CATEGORIES, 'cat-groceries');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: 'Groceries', monthlyCents: 65000, rollover: true });
  });
});

describe('locked state', () => {
  it('treats 401 and 403 the same', () => {
    expect(stateForStatus(401)).toBe('locked');
    expect(stateForStatus(403)).toBe('locked');
    expect(stateForStatus(200)).toBe('ok');
    expect(stateForStatus(500)).toBe('error');
  });
});
