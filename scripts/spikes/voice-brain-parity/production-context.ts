// scripts/spikes/voice-brain-parity/production-context.ts
//
// What the spike takes from production assembly instead of copying (#1968): the
// coordinator's per-turn system string (assembleAgent + buildBaseSystemPrompt, the
// path AgentRuntime sends, #1966), the real specialist roster, and real tool
// definitions for voice's own list (VOICE_TOOL_NAMES) and for the coordinator pin set
// voice used to inherit. No database: the catalog is read from disk with no-op
// handlers, the way src/agents/prompt-budget.ts measures it.
import { resolve } from 'node:path';
import { EventBus } from '../../../src/bus/bus.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import type { LLMProvider, ToolDefinition } from '../../../src/agents/llm/provider.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../src/agents/llm/model-router.js';
import { discoverAgentManifests, loadAgentConfig, type AgentYamlConfig } from '../../../src/agents/loader.js';
import { buildBaseSystemPrompt } from '../../../src/agents/system-prompt.js';
import { TURN_GUIDANCE_HEADER } from '../../../src/agents/prompts/turn-guidance.js';
import { VOICE_ASYNC_OFFRAMP_GUIDANCE } from '../../../src/agents/prompts/voice-async-offramp.js';
import { VOICE_TOOL_RESULT_POLICY, buildVoiceSystemAddendum } from '../../../src/channels/voice/voice-runtime.js';
import { VOICE_TOOL_NAMES } from '../../../src/channels/voice/voice-tools.js';
import { loadYamlConfig } from '../../../src/config.js';
import { DEFAULT_OFFICE_IDENTITY } from '../../../src/identity/defaults.js';
import { turnLengthReminder } from '../../../src/identity/length.js';
import type { OfficeIdentityService } from '../../../src/identity/service.js';
import { createSilentLogger } from '../../../src/logger.js';
import { compileSecurityContextBlock, resolveSecurityThresholds } from '../../../src/security/security-context.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { discoverToolManifests } from '../../../src/skills/loader.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import {
  discoverSkillManifests,
  loadSkillsFromDiscovery,
  registerSyntheticSingletonSkills,
} from '../../../src/skills/skill-loader.js';
import { assembleAgent, registerAgentRoster } from '../../../src/startup/agent-assembly.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
/** UUID-shaped stand-in so ${principal_contact_id} renders at production length. */
const PRINCIPAL_CONTACT_ID = '00000000-0000-4000-8000-000000000000';

export interface ProductionVoiceContext {
  /** The coordinator's "## Available Specialists" roster body, as production builds it. */
  specialistRoster: string;
  /** Voice's own tool list (#1968), as the LLM sees it. */
  voiceToolDefs: ToolDefinition[];
  /** What voice carried before #1968: the coordinator's pins + discovery + async-offramp. */
  coordinatorToolDefs: ToolDefinition[];
  /** The coordinator's per-turn system string at `now`, exactly as AgentRuntime builds it. */
  coordinatorSystemPrompt(now: Date): Promise<string>;
}

/**
 * Build the context once per run. `identityBlock` stands in for the office identity
 * service, so every arm speaks with the same fixture identity.
 */
export function loadProductionVoiceContext(opts: { identityBlock: string; timezone: string }): ProductionVoiceContext {
  const logger = createSilentLogger();
  const skillsDir = resolve(REPO_ROOT, 'skills');
  const agentsDir = resolve(REPO_ROOT, 'agents');

  const toolRegistry = new ToolRegistry(opts.timezone);
  const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };
  for (const disc of discoverToolManifests(skillsDir, logger)) {
    if (!disc.manifest) throw new Error(`tool '${disc.name}' has an invalid manifest: ${disc.error ?? 'unknown'}`);
    toolRegistry.register(disc.manifest, noopHandler);
  }
  const skillRegistry = new SkillRegistry();
  const skillDiscovery = discoverSkillManifests(skillsDir, logger);
  loadSkillsFromDiscovery(skillDiscovery, skillRegistry, logger, new Set(skillDiscovery.map(d => d.name)));
  registerSyntheticSingletonSkills(toolRegistry, skillRegistry, logger);

  const configs: AgentYamlConfig[] = discoverAgentManifests(agentsDir).flatMap(d => (d.config ? [d.config] : []));
  const agentRegistry = new AgentRegistry();
  registerAgentRoster(agentRegistry, configs);

  const thresholds = resolveSecurityThresholds(loadYamlConfig(resolve(REPO_ROOT, 'config')).security?.trust_thresholds);
  if (!thresholds.ok) throw new Error(`invalid security.trust_thresholds: ${thresholds.reason}`);

  // Only the two compile methods are reached for the coordinator (buildBaseSystemPrompt).
  const officeIdentityService = {
    compileSystemPromptBlock: () => opts.identityBlock,
    compileWritesAsBlock: () => opts.identityBlock,
  } as unknown as OfficeIdentityService;

  const modelRegistry = new ModelRegistry(logger);
  const modelRouter = new ModelRouter(
    {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    },
    modelRegistry,
    logger,
  );
  const provider = { id: 'anthropic', chat: async () => { throw new Error('not called'); } } as unknown as LLMProvider;

  const coordinator = assembleAgent(loadAgentConfig(resolve(agentsDir, 'coordinator.yaml')), {
    logger,
    bus: new EventBus(logger),
    toolRegistry,
    skillRegistry,
    agentRegistry,
    models: { modelRouter, modelRegistry, providerRegistry: new Map([['anthropic', provider]]) },
    executionLayer: {} as ExecutionLayer,
    officeIdentityService,
    securityContextBlock: compileSecurityContextBlock(thresholds.thresholds),
    timezone: opts.timezone,
    channelAccounts: {},
    selfEmails: [],
    principalIdentities: [],
    principalPrimaryEmail: { current: null },
    principalContactId: PRINCIPAL_CONTACT_ID,
    agentContactId: PRINCIPAL_CONTACT_ID,
    lateDelivery: { ttlMinutes: 60, sweepIntervalMinutes: 5 },
  });

  const voiceToolDefs = toolRegistry.toToolDefinitions([...VOICE_TOOL_NAMES]);
  if (voiceToolDefs.length !== VOICE_TOOL_NAMES.length) {
    throw new Error('a voice tool did not resolve from the catalog');
  }
  const coordinatorToolDefs = [...coordinator.toolDefs, ...toolRegistry.toToolDefinitions(['async-offramp'])];

  return {
    specialistRoster: coordinator.runtimeConfig.availableSpecialists ?? '',
    voiceToolDefs,
    coordinatorToolDefs,
    coordinatorSystemPrompt: now =>
      buildBaseSystemPrompt(coordinator.runtimeConfig, { now, logger, onBlockError: 'throw' }),
  };
}

/**
 * The voice-channel module for the slim-core arm: what a spoken turn needs that the
 * coordinator core does not say — the audience and spoken style, the honest-negative
 * rule for tool results, and the live-call off-ramp. Composed from the production
 * voice pieces, not copied.
 */
export const VOICE_CHANNEL_MODULE = [
  buildVoiceSystemAddendum({ liveTurn: true }),
  VOICE_TOOL_RESULT_POLICY,
  VOICE_ASYNC_OFFRAMP_GUIDANCE,
].join('\n\n');

/**
 * The slim-core arm's turn guidance (#1959): the voice module heads the caller's
 * message, in the block format renderTurnGuidance() produces, closed by the voice
 * length reminder the runtime already renders for `voice`. Shipping this would add a
 * `voice-call` TurnGuidanceKey; the spike renders the same text without one.
 */
export function renderVoiceTurnGuidance(): string {
  const lengthReminder = turnLengthReminder('voice', DEFAULT_OFFICE_IDENTITY.tone.verbosity);
  return [TURN_GUIDANCE_HEADER, VOICE_CHANNEL_MODULE, ...(lengthReminder ? [lengthReminder] : [])].join('\n\n');
}
