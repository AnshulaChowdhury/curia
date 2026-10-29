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
    expect(result.instructions).toContain('explicitly directed');
    expect(result.instructions).toContain('email-draft-save');
  });
});
