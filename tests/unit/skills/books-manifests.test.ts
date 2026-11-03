import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The books tools are reached by delegation and by scheduled jobs. A tool declared `sensitivity: elevated` is refused in both
// (it needs a live principal turn: ADR-017, ADR-060), so the books agent got "blocked" for every call. Pin the settings that work.

const dir = join(import.meta.dirname, '..', '..', '..', 'skills', 'books', 'tools');
const tools = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

describe('books tool manifests', () => {
  it('finds the three tools', () => {
    expect(tools.sort()).toEqual(['books-review-queue', 'books-summary', 'books-uploads']);
  });

  it.each(tools)('%s can run from a delegation or a scheduled job, and only for the books agent', (name) => {
    const m = JSON.parse(readFileSync(join(dir, name, 'tool.json'), 'utf-8')) as Record<string, unknown>;
    expect(m['sensitivity']).toBe('normal');                 // 'elevated' would block delegated and scheduled calls
    expect(m['action_risk']).toBe('none');                   // read-only
    expect(m['allowed_callers']).toEqual(['books']);         // what keeps other agents out
    expect(m['capabilities']).toEqual(['booksReader']);      // the read-only facade
  });
});
