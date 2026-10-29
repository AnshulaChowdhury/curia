import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { resolveSkillActivation } from '../../../src/skills/skill-activation.js';
import { ToolRegistry } from '../../../src/skills/registry.js';

describe('meeting-minutes-structuring', () => {
  it('loads as an instruction-only skill and is activatable by the coordinator', () => {
    const dir = new URL('../../../skills/meeting-minutes-structuring/', import.meta.url);
    const raw = readFileSync(new URL('SKILL.md', dir), 'utf8');
    const parsed = parseSkillMd(raw, 'meeting-minutes-structuring/SKILL.md');
    expect(parsed.tools).toBeUndefined();
    expect(parsed.instructions.length).toBeGreaterThan(0);
    expect(parsed.instructions.split('\n').length).toBeLessThan(60);

    const skills = new SkillRegistry();
    skills.register({
      name: parsed.name,
      description: parsed.description,
      tools: parsed.tools ?? [],
      instructions: parsed.instructions,
    }, dir.pathname);
    const result = resolveSkillActivation({
      skillName: 'meeting-minutes-structuring',
      skillRegistry: skills,
      toolRegistry: new ToolRegistry(),
      agentId: 'coordinator',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.tools).toEqual([]);
    expect(result.instructions).toContain('**directed** a change');
    expect(result.instructions).toContain('email-draft-save');
  });

  // #2347: the first dry run mailed the raw path, a "Curia's idea" label, and a
  // report after calls that covered nothing, because the playbook asked for all three.
  it('reads its inputs from the progress note and sends only when the call earned it', () => {
    const raw = readFileSync(new URL('../../../skills/meeting-minutes-structuring/SKILL.md', import.meta.url), 'utf8');
    const { instructions } = parseSkillMd(raw, 'meeting-minutes-structuring/SKILL.md');
    expect(instructions).toContain('first progress note');
    expect(instructions).toContain('**Not earned.**');
    expect(instructions).toContain('Otherwise send nothing.');
    expect(instructions).toContain('Never paste the storage path.');
    expect(instructions).not.toMatch(/always send/i);
    expect(instructions).not.toContain('include the minutes path');
  });
});
