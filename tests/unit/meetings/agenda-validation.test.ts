import { describe, expect, it } from 'vitest';
import { isDue, validateParkAgendaInput } from '../../../src/meetings/agenda-validation.js';

const NOW = new Date('2026-10-28T16:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Q3 review',
    topics: ['Pipeline'],
    context: 'The board wants a status.',
    source: 'principal',
    ...overrides,
  };
}

describe('validateParkAgendaInput', () => {
  it('accepts a minimal agenda and defaults sensitivity and expiry', () => {
    const result = validateParkAgendaInput(valid(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sensitivity).toBe('internal');
    expect(result.value.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    expect(result.value.role).toBeNull();
    expect(result.value.scheduledFor).toBeNull();
  });

  it('rejects an empty topics list, 11 topics, and an oversized topic, title, role, or context', () => {
    expect(validateParkAgendaInput(valid({ topics: [] }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ topics: Array.from({ length: 11 }, (_, i) => `t${i}`) }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ topics: ['x'.repeat(201)] }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ title: 't'.repeat(121) }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ role: 'r'.repeat(501) }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ context: 'c'.repeat(6001) }), NOW).ok).toBe(false);
  });

  it('rejects an expiry past the 30-day maximum, an expiry in the past, and unknown enums', () => {
    const tooFar = new Date(NOW.getTime() + 30 * DAY + 1000).toISOString();
    const past = new Date(NOW.getTime() - 1000).toISOString();
    expect(validateParkAgendaInput(valid({ expires_at: tooFar }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ expires_at: past }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ source: 'stranger' }), NOW).ok).toBe(false);
    expect(validateParkAgendaInput(valid({ sensitivity: 'public' }), NOW).ok).toBe(false);
  });
});

describe('isDue', () => {
  it('treats a missing timing hint as due', () => {
    expect(isDue({ scheduledFor: null }, NOW)).toBe(true);
  });

  it('is due inside ±12 hours and not due outside it', () => {
    const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
    expect(isDue({ scheduledFor: iso(11 * 60 * 60 * 1000) }, NOW)).toBe(true);
    expect(isDue({ scheduledFor: iso(13 * 60 * 60 * 1000) }, NOW)).toBe(false);
    expect(isDue({ scheduledFor: iso(-12 * 60 * 60 * 1000) }, NOW)).toBe(true);
  });
});
