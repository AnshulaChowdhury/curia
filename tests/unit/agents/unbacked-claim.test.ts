import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { claimsUnbackedWork, UNBACKED_CLAIM_CORRECTION, UNBACKED_CLAIM_REPLY } from '../../../src/agents/unbacked-claim.js';
import type { LLMProvider, ToolDefinition } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentResponseEvent } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';

const CLAIM = "I've delegated the full setup to the budget agent with your corrections.\n\nYou'll see a card in this chat before anything is saved.";
const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const text = (content: string) => ({ type: 'text' as const, content, usage, provenance: PROVENANCE });
const delegate = { type: 'tool_use' as const, toolCalls: [{ id: 't1', name: 'delegate', input: { agent: 'budget', task: 'propose' } }], usage, provenance: PROVENANCE };
const DELEGATE_DEF: ToolDefinition = { name: 'delegate', description: 'Delegate', input_schema: { type: 'object', properties: {}, required: [] } };

async function turn(replies: unknown[], over: { guidance?: boolean; tools?: ToolDefinition[] } = {}) {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const sent: string[] = [];
  bus.subscribe('agent.response', 'dispatch', e => { sent.push((e as AgentResponseEvent).payload.content); });
  const chat = vi.fn();
  for (const reply of replies) chat.mockResolvedValueOnce(reply);
  chat.mockResolvedValue(replies[replies.length - 1]);
  const invoke = vi.fn(async () => ({ success: true as const, data: { response: 'Proposed 3 categories.' } }));
  const memory = WorkingMemory.createInMemory();
  new AgentRuntime({
    agentId: 'coordinator', systemPrompt: 'You are the coordinator.', provider: { id: 'mock', chat } as LLMProvider, resolvedModel: 'mock-model', bus, logger, memory,
    executionLayer: { invoke, provenanceSourceText: () => undefined } as unknown as ExecutionLayer,
    skillToolDefs: over.tools ?? [DELEGATE_DEF],
  }).register();
  await bus.publish('dispatch', createAgentTask({
    agentId: 'coordinator', conversationId: 'c', channelId: 'web', senderId: 'principal', content: 'Create these categories', parentEventId: 'p',
    ...(over.guidance === false ? {} : { turnGuidance: ['budget-sheet-attached'] }),
  }));
  const history = await memory.getHistory('c', 'coordinator');
  return { sent, chat, invoke, history };
}

describe('claimsUnbackedWork', () => {
  it('catches replies that say work was handed on or done', () => {
    for (const reply of [
      CLAIM,
      "I've created all the income and expense categories in your budget.",
      'The categories are set up with the monthly amounts. The budget agent now has these in place.',
      'I added the rent category.',
      "I'll delegate this to the budget agent now.",
    ]) expect(claimsUnbackedWork(reply), reply).toBe(true);
  });
  it('leaves answers, questions, offers and denials alone', () => {
    for (const reply of [
      'Your budget shows three priorities: savings, debt and family support.',
      'Shall I ask the budget agent to propose these?',
      'Would you like me to create them?',
      'Nothing has been created yet.',
      "I haven't added any categories.",
      'If you confirm, I will ask the budget agent.',
      'I can propose categories from your sheet.',
      'The sheet lists amounts by month.',
    ]) expect(claimsUnbackedWork(reply), reply).toBe(false);
  });
});

describe('AgentRuntime holds back an unbacked claim (ADR-068)', () => {
  it('makes the model delegate, and sends only the reply that follows', async () => {
    const { sent, chat, invoke, history } = await turn([text(CLAIM), delegate, text('Proposed: please check the card.')]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['Proposed: please check the card.']);
    expect(chat.mock.calls.map(c => c[0].toolChoice)).toEqual([undefined, 'delegate', undefined]);
    expect(JSON.stringify(chat.mock.calls[1]![0].messages)).toContain('Curia runtime check');
    expect(JSON.stringify(history)).not.toContain('delegated the full setup');
    expect(JSON.stringify(history)).not.toContain(UNBACKED_CLAIM_CORRECTION);
  });

  it('sends the truth when the model claims it again without calling anything', async () => {
    const { sent, invoke, history } = await turn([text(CLAIM), text(CLAIM)]);
    expect(invoke).not.toHaveBeenCalled();
    expect(sent).toEqual([UNBACKED_CLAIM_REPLY]);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: UNBACKED_CLAIM_REPLY });
  });

  it('leaves a reply backed by a delegation as it is', async () => {
    const { sent, chat } = await turn([delegate, text(CLAIM)]);
    expect(sent).toEqual([CLAIM]);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('checks only turns with a budget sheet attached, where the model can delegate', async () => {
    for (const over of [{ guidance: false }, { tools: [] as ToolDefinition[] }]) {
      const { sent, chat } = await turn([text(CLAIM)], over);
      expect(sent).toEqual([CLAIM]);
      expect(chat).toHaveBeenCalledTimes(1);
    }
  });

  it('does not hold back an ordinary answer', async () => {
    const { sent, chat } = await turn([text('Your sheet has five visible tabs.')]);
    expect(sent).toEqual(['Your sheet has five visible tabs.']);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
