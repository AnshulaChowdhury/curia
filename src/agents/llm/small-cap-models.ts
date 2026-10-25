// small-cap-models.ts — boot check for models on small-cap NO_REASONING call sites (#2224).
//
// Several call sites send NO_REASONING with an output cap too small for thinking:
// the infra-llm classifier (10 tokens), the activity summarizer (40), the drift
// detector (200) and setup's name suggestion (16) on the fast tier; the outbound and
// escalation judges (200 to 1,200); and voice turns. A model that cannot turn
// thinking off spends those caps on thinking. The failures are quiet: the drift
// detector reads a failed call as no drift, and the outbound judge blocks the send.
//
// Each config key below names a model one of those call sites runs on. Boot refuses
// a model that fails ModelRegistry.canTurnThinkingOff. Unknown models are skipped:
// the registry checks for each key already refuse them, or disable voice.

import type { YamlConfig } from '../../config.js';
import type { ModelRegistry } from './model-registry.js';

export interface SmallCapModelSlot {
  /** The config key that sets the model, for the boot error. */
  configKey: string;
  model: string;
}

// Same default the judge builders use when the block names no model.
const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';

/**
 * The models that serve a small-cap NO_REASONING call site under this config.
 * A disabled judge serves none. `voiceModel` is the trimmed `channels.voice.model`
 * override; without it voice runs on the fast tier, which is already listed.
 */
export function smallCapModelSlots(yaml: YamlConfig, voiceModel: string | undefined): SmallCapModelSlot[] {
  const slots: SmallCapModelSlot[] = [];
  const fast = yaml.model_routing?.tiers.fast?.model;
  if (fast) slots.push({ configKey: 'model_routing.tiers.fast.model', model: fast });
  const outboundJudge = yaml.filter?.llmJudge;
  if (outboundJudge?.enabled ?? true) {
    slots.push({ configKey: 'filter.llmJudge.model', model: outboundJudge?.model ?? DEFAULT_JUDGE_MODEL });
  }
  const escalationJudge = yaml.escalation?.judge;
  if (escalationJudge?.enabled ?? true) {
    slots.push({ configKey: 'escalation.judge.model', model: escalationJudge?.model ?? DEFAULT_JUDGE_MODEL });
  }
  if (voiceModel) slots.push({ configKey: 'channels.voice.model', model: voiceModel });
  return slots;
}

/**
 * One line per slot whose model cannot turn thinking off, naming the config key.
 * Empty when every model can.
 */
export function smallCapThinkingViolations(slots: SmallCapModelSlot[], registry: ModelRegistry): string[] {
  return slots
    .filter((s) => registry.isKnownModel(s.model) && !registry.canTurnThinkingOff(s.model))
    .map((s) =>
      `${s.configKey}: "${s.model}" cannot turn thinking off, so it would spend the small output caps of the `
      + 'calls on this model (classifier, judges, drift detector, voice) on thinking. Choose a model whose '
      + 'registry entry lists reasoning effort none, or one that does not think by default.',
    );
}
