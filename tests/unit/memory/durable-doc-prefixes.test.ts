import { describe, expect, it } from 'vitest';
import { isDurableDocPath, isSharedDocPath } from '../../../src/memory/durable-doc-prefixes.js';

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

  it('matches paths under /shared/ (#2338)', () => {
    expect(isDurableDocPath('/shared/inbox/rules.md')).toBe(true);
  });
});

describe('isSharedDocPath', () => {
  it('matches /shared/ after normalizing', () => {
    expect(isSharedDocPath('shared/inbox/rules.md')).toBe(true);
    expect(isSharedDocPath('/projects/../shared/a.md')).toBe(true);
  });

  it('does not match other durable prefixes or look-alikes', () => {
    expect(isSharedDocPath('/meetings/agendas/a.md')).toBe(false);
    expect(isSharedDocPath('/sharedx/a.md')).toBe(false);
  });
});
