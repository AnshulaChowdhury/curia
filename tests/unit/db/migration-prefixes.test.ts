// Two migrations with the same number take prod down on startup (node-pg-migrate checkOrder), so CI refuses a new duplicate.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const DIR = fileURLToPath(new URL('../../../src/db/migrations/', import.meta.url));

// Both 121 files are already applied in production. Renaming either would make the recorded names disagree with the
// files and fail checkOrder, so this one pair stays; any other repeat is a new collision.
const GRANDFATHERED = new Set(['121']);

describe('migration numbering', () => {
  it('has no duplicate prefix beyond the grandfathered pair', () => {
    const seen = new Map<string, string[]>();
    for (const f of readdirSync(DIR).filter(n => /^\d+_.+\.sql$/.test(n))) {
      const prefix = f.split('_')[0]!;
      seen.set(prefix, [...(seen.get(prefix) ?? []), f]);
    }
    const dupes = [...seen].filter(([p, files]) => files.length > 1 && !GRANDFATHERED.has(p));
    expect(dupes).toEqual([]);
  });

  it('still has exactly the two applied 121 files, so the exemption cannot hide a third', () => {
    const files = readdirSync(DIR).filter(n => n.startsWith('121_')).sort();
    expect(files).toEqual(['121_books_pipeline_state.sql', '121_inbox_triage_preferences.sql']);
  });
});
