import { describe, expect, it } from 'vitest';
import { isDurableDocPath } from '../../../src/memory/durable-doc-prefixes.js';

describe('isDurableDocPath', () => {
  it('matches paths under /meetings/', () => {
    expect(isDurableDocPath('/meetings/agendas/a.md')).toBe(true);
  });

  it('normalizes a missing leading slash', () => {
    expect(isDurableDocPath('meetings/minutes/x.md')).toBe(true);
  });

  it('does not match project documents', () => {
    expect(isDurableDocPath('/projects/x/brief.md')).toBe(false);
  });

  it('does not match a prefix that only shares the letters', () => {
    expect(isDurableDocPath('/meetingsx/a.md')).toBe(false);
  });
});
