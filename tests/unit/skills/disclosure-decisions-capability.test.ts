// disclosure-decisions-capability.test.ts — who may record the principal's answer to a
// personal-data ask (#2312).
//
// A `disclosure_decisions` yes authorizes a label to a recipient on a thread for every later
// send there, so only the tools that resolve an ask's approval on the principal's word may
// write one: approve-action and deny-action, and send-draft, which sends a held draft directly
// and resolves its row. A new tool declaring the capability has to be added here on purpose.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// tests/unit/skills/ → ../../../skills/
const SKILLS_DIR = path.join(import.meta.dirname, '../../../skills');

/** Every tool.json under skills/, flat (skills/<tool>/) and bundled (skills/<bundle>/tools/<tool>/). */
function collectManifestPaths(): string[] {
  const manifests: string[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const flat = path.join(SKILLS_DIR, entry.name, 'tool.json');
    if (fs.existsSync(flat)) manifests.push(flat);
    const toolsDir = path.join(SKILLS_DIR, entry.name, 'tools');
    if (!fs.existsSync(toolsDir)) continue;
    for (const tool of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (!tool.isDirectory()) continue;
      const bundled = path.join(toolsDir, tool.name, 'tool.json');
      if (fs.existsSync(bundled)) manifests.push(bundled);
    }
  }
  return manifests;
}

describe('the disclosureDecisions capability', () => {
  it('is declared only by approve-action, deny-action and send-draft', () => {
    const manifests = collectManifestPaths();
    // Guard against a walk that silently finds nothing.
    expect(manifests.length).toBeGreaterThan(50);
    const declaring = manifests
      .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')) as { name: string; capabilities?: unknown })
      .filter((m) => Array.isArray(m.capabilities) && m.capabilities.includes('disclosureDecisions'))
      .map((m) => m.name)
      .sort();
    expect(declaring).toEqual(['approve-action', 'deny-action', 'send-draft']);
  });
});
