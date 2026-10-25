import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { YamlConfig } from '../../../../src/config.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { smallCapModelSlots, smallCapThinkingViolations } from '../../../../src/agents/llm/small-cap-models.js';
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
    expect(smallCapModelSlots(config(), undefined)).toEqual([
      { configKey: 'model_routing.tiers.fast.model', model: 'claude-haiku-5-5' },
      { configKey: 'filter.llmJudge.model', model: 'claude-haiku-5-5' },
      { configKey: 'escalation.judge.model', model: 'claude-haiku-5-5' },
    ]);
  });

  it('leaves out a disabled judge and adds the voice override', () => {
    const slots = smallCapModelSlots(
      config({ outboundJudge: { enabled: false, model: 'claude-opus-5-5' }, escalationJudge: { enabled: false } }),
      'claude-sonnet-5-5',
    );
    expect(slots.map((s) => s.configKey)).toEqual(['model_routing.tiers.fast.model', 'channels.voice.model']);
  });

  it('does not list the standard tier, which no small-cap call site runs on', () => {
    expect(smallCapModelSlots(config({ standard: 'claude-opus-5-5' }), undefined).map((s) => s.model)).not.toContain('claude-opus-5-5');
  });
});

describe('smallCapThinkingViolations (#2224)', () => {
  it.each([
    ['model_routing.tiers.fast.model', config({ fast: 'claude-opus-5-5' }), undefined],
    ['filter.llmJudge.model', config({ outboundJudge: { model: 'claude-opus-5-5' } }), undefined],
    ['escalation.judge.model', config({ escalationJudge: { model: 'claude-opus-5-5' } }), undefined],
    ['channels.voice.model', config(), 'claude-opus-5-5'],
  ])('refuses Opus 5.5 as %s and names the key', (key, yamlConfig, voiceModel) => {
    const violations = smallCapThinkingViolations(smallCapModelSlots(yamlConfig, voiceModel), registry);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`${key}: "claude-opus-5-5" cannot turn thinking off`);
  });

  it('refuses DeepSeek V4.1 Flash as a judge', () => {
    const violations = smallCapThinkingViolations(
      smallCapModelSlots(config({ outboundJudge: { model: 'deepseek/deepseek-v4.1-flash' } }), undefined),
      registry,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('filter.llmJudge.model');
  });

  it('skips unknown models, which the per-key registry checks handle', () => {
    expect(smallCapThinkingViolations([{ configKey: 'channels.voice.model', model: 'no-such-model' }], registry)).toEqual([]);
  });

  it('accepts the production model choices (curia-deploy custom/config/local.yaml, 2026-10-25)', () => {
    const prod = config({
      fast: 'claude-haiku-5-5',
      standard: 'deepseek/deepseek-v4.1-flash',
      outboundJudge: { enabled: true, model: 'google/gemini-3.1-flash-lite' },
      escalationJudge: { enabled: true, model: 'google/gemini-3.1-flash-lite' },
    });
    expect(smallCapThinkingViolations(smallCapModelSlots(prod, 'claude-haiku-5-5'), registry)).toEqual([]);
  });

  it('accepts config/default.yaml', () => {
    const defaults = yaml.load(readFileSync(join(import.meta.dirname, '../../../../config/default.yaml'), 'utf8')) as YamlConfig;
    const voice = defaults.channels?.voice?.model?.trim() || undefined;
    expect(smallCapThinkingViolations(smallCapModelSlots(defaults, voice), registry)).toEqual([]);
  });
});
