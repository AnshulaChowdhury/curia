import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as yaml from 'js-yaml';
import type { YamlConfig } from '../../../../src/config.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { smallCapModelSlots, smallCapThinkingViolations, voiceModelSlot } from '../../../../src/agents/llm/small-cap-models.js';
import { createSilentLogger } from '../../../../src/logger.js';

const registry = new ModelRegistry(createSilentLogger());

function config(overrides: {
  fast?: string;
  standard?: string;
  outboundJudge?: { enabled?: boolean; model?: string };
  escalationJudge?: { enabled?: boolean; model?: string };
} = {}): YamlConfig {
  return {
    model_routing: {
      tiers: {
        fast: { model: overrides.fast ?? 'claude-haiku-5-5' },
        standard: { model: overrides.standard ?? 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    },
    filter: { llmJudge: overrides.outboundJudge },
    escalation: { judge: overrides.escalationJudge },
  } as unknown as YamlConfig;
}

describe('smallCapModelSlots (#2224)', () => {
  it('lists the fast tier and both judges, defaulting a judge with no model to Haiku 5.5', () => {
    expect(smallCapModelSlots(config())).toEqual([
      { configKey: 'model_routing.tiers.fast.model', model: 'claude-haiku-5-5' },
      { configKey: 'filter.llmJudge.model', model: 'claude-haiku-5-5' },
      { configKey: 'escalation.judge.model', model: 'claude-haiku-5-5' },
    ].map((s) => expect.objectContaining(s)));
  });

  it('leaves out a disabled judge', () => {
    const slots = smallCapModelSlots(
      config({ outboundJudge: { enabled: false, model: 'claude-opus-5-5' }, escalationJudge: { enabled: false } }),
    );
    expect(slots.map((s) => s.configKey)).toEqual(['model_routing.tiers.fast.model']);
  });

  it('leaves out the voice override, which boot checks only where the voice adapter starts', () => {
    expect(smallCapModelSlots(config()).map((s) => s.configKey)).not.toContain('channels.voice.model');
    expect(voiceModelSlot('claude-opus-5-5')).toMatchObject({ configKey: 'channels.voice.model', model: 'claude-opus-5-5' });
  });

  it('does not list the standard tier, which no small-cap call site runs on', () => {
    expect(smallCapModelSlots(config({ standard: 'claude-opus-5-5' })).map((s) => s.model)).not.toContain('claude-opus-5-5');
  });
});

describe('smallCapThinkingViolations (#2224)', () => {
  it.each([
    ['model_routing.tiers.fast.model', smallCapModelSlots(config({ fast: 'claude-opus-5-5' }))],
    ['filter.llmJudge.model', smallCapModelSlots(config({ outboundJudge: { model: 'claude-opus-5-5' } }))],
    ['escalation.judge.model', smallCapModelSlots(config({ escalationJudge: { model: 'claude-opus-5-5' } }))],
    ['channels.voice.model', [voiceModelSlot('claude-opus-5-5')]],
  ])('refuses Opus 5.5 as %s and names the key', (key, slots) => {
    const violations = smallCapThinkingViolations(slots, registry);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`${key}: "claude-opus-5-5" cannot turn thinking off`);
  });

  it('refuses DeepSeek V4.1 Flash as a judge', () => {
    const violations = smallCapThinkingViolations(
      smallCapModelSlots(config({ outboundJudge: { model: 'deepseek/deepseek-v4.1-flash' } })),
      registry,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('filter.llmJudge.model');
    // Names the judge, not the fast-tier call sites.
    expect(violations[0]).toContain('outbound leak judge');
    expect(violations[0]).not.toContain('classifier');
  });

  it('skips unknown models, which the per-key registry checks handle', () => {
    expect(smallCapThinkingViolations([{ configKey: 'channels.voice.model', model: 'no-such-model', callSites: 'voice turns' }], registry)).toEqual([]);
  });

  // The ids are inlined, so this shows these models pass the predicate, not that the
  // current curia-deploy config boots: that file lives in another repo.
  it('passes the model ids curia-deploy production uses for these keys', () => {
    const prod = config({
      fast: 'claude-haiku-5-5',
      standard: 'deepseek/deepseek-v4.1-flash',
      outboundJudge: { enabled: true, model: 'google/gemini-3.1-flash-lite' },
      escalationJudge: { enabled: true, model: 'google/gemini-3.1-flash-lite' },
    });
    expect(smallCapThinkingViolations([...smallCapModelSlots(prod), voiceModelSlot('claude-haiku-5-5')], registry)).toEqual([]);
  });

  it('accepts config/default.yaml', () => {
    const defaults = yaml.load(readFileSync(join(import.meta.dirname, '../../../../config/default.yaml'), 'utf8')) as YamlConfig;
    const voice = defaults.channels?.voice?.model?.trim();
    const slots = [...smallCapModelSlots(defaults), ...(voice ? [voiceModelSlot(voice)] : [])];
    expect(smallCapThinkingViolations(slots, registry)).toEqual([]);
  });
});

// `infraLlm.extract` defaults to the standard tier, which boot does not check. On a
// model that thinks, no extract cap is safe: on 2026-10-25 DeepSeek V4.1 Flash spent
// 3,000 tokens reasoning on a 1,000-token extract-facts call and returned no text, and
// #2191 saw the same at the 4,000 default. So every extract runs on fast. A call that
// must stay on standard goes here, with its reason (file path → number of calls).
const STANDARD_TIER_EXTRACTS: Readonly<Record<string, number>> = {};

const REPO = join(import.meta.dirname, '../../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath, e.name));
}

// The argument text of each `.extract(` call, with parentheses balanced outside string
// literals (template `${…}` contents are code, so their parentheses count).
function extractCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('.extract(', from);
    if (at === -1) return calls;
    const start = at + '.extract('.length;
    let depth = 1;
    let quote: string | null = null;
    const templateDepth: number[] = [];
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (quote) {
        if (c === '\\') i++;
        else if (quote === '`' && c === '$' && source[i + 1] === '{') { templateDepth.push(depth); depth++; quote = null; i++; }
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') {
        depth--;
        if (c === '}' && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === depth) {
          templateDepth.pop();
          quote = '`';
        }
      }
    }
    calls.push(source.slice(start, i - 1));
    from = i;
  }
}

describe('standard tier serves no small-cap extract (#2224)', () => {
  it("every infraLlm.extract sets tier: 'fast' unless STANDARD_TIER_EXTRACTS lists it", () => {
    const offenders: string[] = [];
    const onStandard: Record<string, number> = {};
    let checked = 0;
    for (const file of [...sourceFiles(join(REPO, 'src')), ...sourceFiles(join(REPO, 'skills'))]) {
      const path = relative(REPO, file);
      for (const call of extractCalls(readFileSync(file, 'utf8'))) {
        checked++;
        if (/tier:\s*'fast'/.test(call)) continue;
        onStandard[path] = (onStandard[path] ?? 0) + 1;
        if (!(path in STANDARD_TIER_EXTRACTS)) {
          const cap = /maxTokens:\s*(\d[\d_]*)/.exec(call)?.[1] ?? 'default 4000';
          offenders.push(`${path}: maxTokens ${cap}`);
        }
      }
    }
    // The scan must find the known calls, or a parsing change would pass vacuously.
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
    // A listed file must still have exactly its listed calls on standard, so the list
    // cannot silently cover a new call or outlive the ones it names.
    expect(onStandard).toEqual(STANDARD_TIER_EXTRACTS);
  });
});
