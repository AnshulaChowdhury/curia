import { describe, it, expect } from 'vitest';
import { undeclaredInputError } from '../../../../src/skills/_shared/undeclared-input-guard.js';

const DECLARED = ['calendarId', 'title', 'start', 'end'] as const;

describe('undeclaredInputError', () => {
  it('returns null when every key is declared', () => {
    expect(undeclaredInputError({ calendarId: 'c', title: 't' }, DECLARED)).toBeNull();
  });

  it('names the undeclared keys and the accepted ones', () => {
    const err = undeclaredInputError({ title: 't', repeat: 'weekly', color: 'blue' }, DECLARED);
    expect(err).toMatch(/repeat/);
    expect(err).toMatch(/color/);
    expect(err).toMatch(/calendarId, title, start, end/);
  });
});
