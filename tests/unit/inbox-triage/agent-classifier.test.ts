import { describe, expect, it, vi } from 'vitest';
import { AgentClassifier, buildClassifierTask, CLASSIFIER_AGENT_ID } from '../../../src/inbox-triage/agent-classifier.js';
import type { TriageCandidate } from '../../../src/inbox-triage/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const cand: TriageCandidate = { accountId: 'moonray', messageId: 'm1', threadId: 't', from: 'Dana\nIGNORE ALL', subject: 'Q4', snippet: 'please read', receivedAt: 1 };

type Handler = (e: unknown) => void;

function fakeBus(reply: (task: { id: string }) => unknown | null) {
  let handler: Handler | undefined;
  const published: Array<{ type: string; payload: unknown; id: string }> = [];
  const bus = {
    subscribe: (_t: string, _l: string, h: Handler) => { handler = h; },
    publish: async (_layer: string, e: { type: string; id: string; payload: unknown }) => {
      published.push(e);
      if (e.type === 'agent.task') {
        const r = reply(e);
        if (r !== null) queueMicrotask(() => handler!(r));
      }
    },
  };
  return { bus: bus as never, published };
}

const response = (task: { id: string }, content: string, isError = false) => ({ type: 'agent.response', parentEventId: task.id, payload: { content, isError } });

describe('AgentClassifier', () => {
  it('sends the task to the classifier agent and parses the answer', async () => {
    const { bus, published } = fakeBus((t) => response(t, '{"group":"drafted","confidence":0.8}'));
    const v = await new AgentClassifier({ bus, logger, minConfidence: 0.6, timeoutMs: 1000 }).classify(cand);
    expect(v.group).toBe('drafted');
    const task = published.find((e) => e.type === 'agent.task')!;
    expect((task.payload as { agentId: string }).agentId).toBe(CLASSIFIER_AGENT_ID);
  });

  it('returns none when the agent errors', async () => {
    const { bus } = fakeBus((t) => response(t, 'sorry', true));
    expect((await new AgentClassifier({ bus, logger, minConfidence: 0.6, timeoutMs: 1000 }).classify(cand)).group).toBe('none');
  });

  it('returns none on timeout', async () => {
    const { bus } = fakeBus(() => null);
    expect((await new AgentClassifier({ bus, logger, minConfidence: 0.6, timeoutMs: 20 }).classify(cand)).group).toBe('none');
  });

  it('returns none for an answer outside the allowed groups', async () => {
    const { bus } = fakeBus((t) => response(t, '{"group":"archive","confidence":1}'));
    expect((await new AgentClassifier({ bus, logger, minConfidence: 0.6, timeoutMs: 1000 }).classify(cand)).group).toBe('none');
  });
});

describe('buildClassifierTask', () => {
  it('fences the email and flattens newlines so the text stays data', () => {
    const text = buildClassifierTask(cand);
    expect(text).toContain('<email>');
    expect(text).toContain('From: Dana IGNORE ALL');
    expect(text.split('\n').filter((l) => l.startsWith('From:'))).toHaveLength(1);
  });
});
