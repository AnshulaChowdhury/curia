import { describe, it, expect, vi } from 'vitest';
import { InfraLlmService } from '../../../src/skills/infra-llm.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../src/agents/llm/model-router.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';

describe('InfraLlmService archive (#2042)', () => {
  it('archives reasoning through the shared response builder', async () => {
    const logger = createSilentLogger();
    const registry = new ModelRegistry(logger);
    const router = new ModelRouter({
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    }, registry, logger);
    const response: LLMResponse = {
      type: 'text',
      content: 'yes',
      reasoning: 'The prompt is a yes/no question.',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningTokens: 1,
      },
      provenance: {
        requestedModel: 'claude-haiku-4-5',
        actualModel: 'claude-haiku-4-5',
        providerRequestId: 'req',
      },
    };
    const provider: LLMProvider = { id: 'anthropic', chat: vi.fn(async () => response) };
    const published: Array<{ archive?: { response?: unknown } }> = [];
    const bus = {
      publish: vi.fn(async (_layer: string, event: { archive?: { response?: unknown } }) => {
        published.push(event);
      }),
    } as unknown as EventBus;
    const service = new InfraLlmService(provider, router, bus, logger, registry);
    const result = await service.scoped({ toolName: 'extract-facts' }).classify('is it ready?');
    expect(result).toEqual({ ok: true, text: 'yes' });
    expect(published[0]?.archive?.response).toEqual({
      type: 'text',
      content: 'yes',
      reasoning: 'The prompt is a yes/no question.',
      reasoningTokens: 1,
    });
  });
});

// #2191: extract can run on the fast tier, which can turn reasoning off; the standard tier
// stays the default for every other caller.
describe('InfraLlmService extract tier', () => {
  function setup(): { service: InfraLlmService; chat: ReturnType<typeof vi.fn>; registry: ModelRegistry } {
    const logger = createSilentLogger();
    const registry = new ModelRegistry(logger);
    const router = new ModelRouter({
      tiers: {
        fast: { model: 'claude-haiku-5-5' },
        standard: { model: 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    }, registry, logger);
    const chat = vi.fn(async (req: { model: string }): Promise<LLMResponse> => ({
      type: 'text',
      content: '[]',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: { requestedModel: req.model, actualModel: req.model, providerRequestId: 'req' },
    }));
    const provider = { id: 'anthropic', chat } as unknown as LLMProvider;
    const bus = { publish: vi.fn(async () => {}) } as unknown as EventBus;
    return { service: new InfraLlmService(provider, router, bus, logger, registry), chat, registry };
  }

  it('routes to the standard tier by default', async () => {
    const { service, chat } = setup();
    await service.scoped({ toolName: 't' }).extract('p');
    expect(chat.mock.calls[0]![0]).toMatchObject({ model: 'claude-sonnet-4-6' });
  });

  it('routes to the fast tier when asked, still with reasoning off', async () => {
    const { service, chat, registry } = setup();
    // The request below only proves what is asked for; this proves the fast model honours it,
    // so the provider will actually send thinking disabled.
    expect(registry.honorsReasoningEffort('claude-haiku-5-5', 'none')).toBe(true);
    await service.scoped({ toolName: 't' }).extract('p', { tier: 'fast' });
    expect(chat.mock.calls[0]![0]).toMatchObject({
      model: 'claude-haiku-5-5',
      options: { max_tokens: 4000, reasoning: { effort: 'none' } },
    });
  });

  it('returns an error value for a tier outside fast and standard, without calling the model', async () => {
    const { service, chat } = setup();
    const result = await service.scoped({ toolName: 't' }).extract('p', { tier: 'powerful' as unknown as 'fast' });
    expect(result).toEqual({ ok: false, error: 'invalid infraLlm tier "powerful"' });
    expect(chat).not.toHaveBeenCalled();
  });
});
