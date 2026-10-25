// Mid-turn injection (#2018, E-1..E-10 and the dispatcher admission rules).
// No database: an in-memory bus, an in-memory working memory, and a scripted model.
// The delegate early-return (E-4) lands with the input signal in the next PR.

import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { TurnLanes } from '../../src/dispatch/turn-lanes.js';
import { EventBus } from '../../src/bus/bus.js';
import {
  createAgentTask,
  createInboundMessage,
  type AgentResponseEvent,
  type AgentTaskEvent,
  type AgentTaskInputInjectedEvent,
} from '../../src/bus/events.js';
import type { LLMProvider, LLMResponse } from '../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { InboundScanner } from '../../src/dispatch/inbound-scanner.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createLogger } from '../../src/logger.js';
import pino from 'pino';

const CONTACT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;

function text(content: string): LLMResponse {
  return { type: 'text', content, usage: USAGE, provenance: PROVENANCE };
}

function toolUse(name: string): LLMResponse {
  return {
    type: 'tool_use',
    toolCalls: [{ id: `call-${name}`, name, input: {} }],
    content: '',
    usage: USAGE,
    provenance: PROVENANCE,
  };
}

function transcript(messages: unknown): string {
  return JSON.stringify(messages);
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function person(contactId: string, systemRole: 'principal' | null) {
  return {
    resolved: true as const,
    contactId,
    displayName: systemRole === 'principal' ? 'Ada Lovelace' : 'Grace Hopper',
    role: null,
    systemRole,
    tier: systemRole === 'principal' ? 'principal' as const : 'known' as const,
    kind: 'person' as const,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 1,
  };
}

interface HarnessOptions {
  max?: number;
  contacts?: Record<string, ReturnType<typeof person>>;
  unresolved?: boolean;
  scannerFindings?: boolean;
  memory?: WorkingMemory;
  execution?: boolean;
  /** Default true. Turn-start and thrown-host cases must not wait on the model. */
  holdFirst?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const acked: string[] = [];
  const logger = createLogger('error');
  const bus = new EventBus(logger, undefined, async (id) => {
    acked.push(id);
  });
  const lanes = new TurnLanes({
    enabled: true,
    maxInjectionsPerTurn: options.max ?? 5,
    extraRoundsPerInjection: 2,
    laneWaitTimeoutMs: 60_000,
    logger: pino({ level: 'silent' }),
  });
  const tasks: AgentTaskEvent[] = [];
  const responses: AgentResponseEvent[] = [];
  const injected: AgentTaskInputInjectedEvent[] = [];
  bus.subscribe('agent.task', 'system', (event) => {
    tasks.push(event as AgentTaskEvent);
  });
  bus.subscribe('agent.response', 'system', (event) => {
    responses.push(event as AgentResponseEvent);
  });
  bus.subscribe('agent.task.input_injected', 'system', (event) => {
    injected.push(event as AgentTaskInputInjectedEvent);
  });
  const contacts = options.contacts ?? { 'ada@example.com': person(CONTACT_A, 'principal') };
  const resolver = {
    resolve: async (channel: string, senderId: string) => {
      if (options.unresolved) return { resolved: false, channel, senderId };
      return contacts[senderId] ?? { resolved: false, channel, senderId };
    },
  } as unknown as ContactResolver;
  const scanner = options.scannerFindings
    ? {
        scan: (raw: string) => ({
          sanitizedContent: raw,
          riskScore: 1,
          findings: [{ pattern: 'ignore', match: 'ignore' }],
        }),
      } as unknown as InboundScanner
    : undefined;
  const invokes: Array<{ liveTurn?: boolean; taskMetadata?: Record<string, unknown> }> = [];
  const execution = {
    invoke: vi.fn(async (_name: string, _input: unknown, _caller: unknown, invokeOptions: { liveTurn?: boolean; taskMetadata?: Record<string, unknown> }) => {
      invokes.push({ liveTurn: invokeOptions?.liveTurn, taskMetadata: invokeOptions?.taskMetadata });
      return { success: true, data: { ok: true } };
    }),
  } as unknown as ExecutionLayer;
  const memory = options.memory ?? WorkingMemory.createInMemory();
  const tryInject = vi.spyOn(lanes, 'tryInject');
  const held = deferred<void>();
  const chats: unknown[] = [];
  let chatIndex = 0;
  const script: LLMResponse[] = [];
  const provider: LLMProvider = {
    id: 'mock',
    chat: vi.fn(async (params: { messages: unknown[] }) => {
      const index = chatIndex;
      chatIndex += 1;
      chats.push(params.messages);
      if (options.holdFirst !== false && index === 0) await held.promise;
      return script[index] ?? text('done');
    }),
  };
  new Dispatcher({
    bus,
    logger,
    contactResolver: resolver,
    turnLanes: lanes,
    ...(scanner ? { injectionScanner: scanner } : {}),
  }).register();
  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'x',
    provider,
    resolvedModel: 'mock-model',
    bus,
    logger,
    turnLanes: lanes,
    memory,
    timezone: 'America/Toronto',
    ...(options.execution === false ? {} : { executionLayer: execution }),
  }).register();

  function inbound(content: string, senderId = 'ada@example.com', extra: { conversationId?: string; channelId?: string; metadata?: Record<string, unknown> } = {}) {
    return createInboundMessage({
      conversationId: extra.conversationId ?? 'email:thread-1',
      channelId: extra.channelId ?? 'email',
      senderId,
      content,
      metadata: extra.metadata,
    });
  }

  return { bus, lanes, tasks, responses, injected, acked, chats, held, script, provider, invokes, memory, inbound, tryInject };
}

describe('turn injection (#2018)', () => {
  it('E-5: a second principal message on an idle conversation is drained at turn start', async () => {
    const memory = WorkingMemory.createInMemory();
    const original = memory.getHistory.bind(memory);
    const gate = deferred<void>();
    let historyCalls = 0;
    vi.spyOn(memory, 'getHistory').mockImplementation(async (...args: Parameters<WorkingMemory['getHistory']>) => {
      historyCalls += 1;
      if (historyCalls === 1) await gate.promise;
      return original(...args);
    });
    const h = harness({ memory, holdFirst: false });
    h.script.push(text('one reply'));
    const first = h.bus.publish('channel', h.inbound('first message'));
    await vi.waitFor(() => expect(historyCalls).toBe(1));
    const secondEvent = h.inbound('second message');
    const second = h.bus.publish('channel', secondEvent);
    await vi.waitFor(() => {
      expect(h.tryInject.mock.results.some((result) => result.type === 'return' && result.value.kind === 'queued')).toBe(true);
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(h.tasks).toHaveLength(1);
    expect(h.responses).toHaveLength(1);
    expect(transcript(h.chats[0])).toContain('second message');
    expect(transcript(h.chats[0])).toContain('New message from Ada Lovelace');
    expect(h.injected.length).toBeGreaterThan(0);
    const turns = await memory.getHistory('email:thread-1', 'coordinator', { raw: true });
    const injectedTurn = turns.find((turn) => turn.injected === true);
    expect(injectedTurn?.content).toBe('second message');
    expect(h.acked).toContain(secondEvent.id);
  });

  it('E-2 and E-3: a follow-up during the final text call is an exit drain and one reply', async () => {
    const h = harness();
    h.script.push(text('draft that must not go out'), text('using email'));
    const first = h.bus.publish('channel', h.inbound('sign in'));
    await vi.waitFor(() => expect(h.chats).toHaveLength(1));
    const secondEvent = h.inbound('use email for the code');
    const second = h.bus.publish('channel', secondEvent);
    await vi.waitFor(() => {
      expect(h.tryInject.mock.results.some((result) => result.type === 'return' && result.value.kind === 'queued')).toBe(true);
    });
    expect(h.acked).not.toContain(secondEvent.id);
    h.held.resolve();
    await Promise.all([first, second]);
    expect(h.tasks).toHaveLength(1);
    expect(h.responses).toHaveLength(1);
    expect(h.responses[0]!.payload.content).toBe('using email');
    expect(transcript(h.chats[0])).not.toContain('use email for the code');
    expect(transcript(h.chats[1])).toContain('use email for the code');
    expect(transcript(h.chats[1])).toContain('was **not** sent');
    expect(h.injected.map((event) => event.payload.drainPoint)).toContain('exit');
    expect(h.acked).toContain(secondEvent.id);
    expect(JSON.stringify(h.injected)).not.toContain('use email for the code');
  });

  it('E-6: a third party on the same thread is not injected', async () => {
    const h = harness({
      contacts: {
        'ada@example.com': person(CONTACT_A, 'principal'),
        'grace@example.com': person(CONTACT_B, null),
      },
    });
    h.script.push(text('principal reply'), text('grace reply'));
    const principal = h.bus.publish('channel', h.inbound('hello from ada'));
    await vi.waitFor(() => expect(h.chats).toHaveLength(1));
    const other = h.bus.publish('channel', h.inbound('hello from grace', 'grace@example.com'));
    await vi.waitFor(() => expect(h.tasks).toHaveLength(2));
    expect(transcript(h.chats[0])).not.toContain('hello from grace');
    h.held.resolve();
    await Promise.all([principal, other]);
    expect(h.responses).toHaveLength(2);
    expect(transcript(h.chats[1])).toContain('hello from grace');
    expect(transcript(h.chats[1])).not.toContain('New message from');
    expect(h.injected).toHaveLength(0);
  });

  it('E-8: the sixth follow-up is returned and runs as the next turn', async () => {
    const h = harness({ max: 5 });
    h.script.push(text('draft'), text('folded'), text('sixth reply'));
    const host = h.bus.publish('channel', h.inbound('host'));
    await vi.waitFor(() => expect(h.chats).toHaveLength(1));
    const rest = [];
    for (let i = 1; i <= 6; i += 1) {
      rest.push(h.bus.publish('channel', h.inbound(`follow ${i}`)));
    }
    await vi.waitFor(() => expect(h.tasks).toHaveLength(2));
    h.held.resolve();
    await Promise.all([host, ...rest]);
    expect(h.responses).toHaveLength(2);
    const folded = transcript(h.chats[1]);
    for (let i = 1; i <= 5; i += 1) expect(folded).toContain(`follow ${i}`);
    expect(folded).not.toContain('follow 6');
    expect(transcript(h.chats[2])).toContain('follow 6');
  });

  it('E-9: a host that throws returns the queued follow-up, and the error reply is still sent', async () => {
    const memory = WorkingMemory.createInMemory();
    const gate = deferred<void>();
    let historyCalls = 0;
    const original = memory.getHistory.bind(memory);
    vi.spyOn(memory, 'getHistory').mockImplementation(async (...args: Parameters<WorkingMemory['getHistory']>) => {
      historyCalls += 1;
      if (historyCalls === 1) {
        await gate.promise;
      }
      return original(...args);
    });
    const h = harness({ memory, holdFirst: false });
    h.script.push(text('follow reply'));
    const hostEvent = h.inbound('host');
    const host = h.bus.publish('channel', hostEvent);
    await vi.waitFor(() => expect(historyCalls).toBe(1));
    const followEvent = h.inbound('after the crash');
    const follow = h.bus.publish('channel', followEvent);
    await vi.waitFor(() => expect(h.tasks).toHaveLength(1));
    expect(h.acked).not.toContain(followEvent.id);
    gate.reject(new Error('memory down'));
    await Promise.all([host, follow]);
    expect(h.responses.some((event) => event.payload.isError === true)).toBe(true);
    expect(h.tasks.length).toBeGreaterThanOrEqual(2);
    expect(h.chats.some((messages) => transcript(messages).includes('after the crash'))).toBe(true);
    expect(h.acked).toContain(followEvent.id);
  });

  it('E-10: in a Signal group, the same member is injected and the other member waits', async () => {
    const h = harness({
      contacts: {
        'aci-x': person(CONTACT_A, null),
        'aci-y': person(CONTACT_B, null),
      },
    });
    h.script.push(text('x reply'), text('x again reply'), text('y reply'));
    const conv = { conversationId: 'signal:group:1', channelId: 'signal' };
    const first = h.bus.publish('channel', h.inbound('from x', 'aci-x', conv));
    await vi.waitFor(() => expect(h.chats).toHaveLength(1));
    const again = h.bus.publish('channel', h.inbound('x again', 'aci-x', conv));
    const other = h.bus.publish('channel', h.inbound('from y', 'aci-y', conv));
    await vi.waitFor(() => expect(h.tasks).toHaveLength(2));
    h.held.resolve();
    await Promise.all([first, again, other]);
    expect(transcript(h.chats[1])).toContain('x again');
    expect(transcript(h.chats[1])).not.toContain('from y');
    expect(h.chats.some((messages) => transcript(messages).includes('from y'))).toBe(true);
  });

  it('E-7: a synthetic wake during a live turn waits and runs afterwards', async () => {
    const h = harness();
    h.script.push(text('principal reply'), text('wake reply'));
    const live = h.bus.publish('channel', h.inbound('live principal'));
    await vi.waitFor(() => expect(h.chats).toHaveLength(1));
    const wake = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-1',
      channelId: 'email',
      senderId: 'scheduler',
      content: 'LATE-WAKE-BRIEF',
      syntheticTurn: true,
      parentEventId: 'wake-parent',
      metadata: {
        originator: { contactId: CONTACT_A, systemRole: 'principal', channel: 'email', tier: 'principal' },
        lateDelegation: { agent: 'researcher', task: 'look up the code' },
      },
    });
    const wakeTurn = h.bus.publish('dispatch', wake);
    await Promise.resolve();
    expect(transcript(h.chats[0])).not.toContain('LATE-WAKE-BRIEF');
    h.held.resolve();
    await Promise.all([live, wakeTurn]);
    expect(h.chats.some((messages) => transcript(messages).includes('LATE-WAKE-BRIEF'))).toBe(true);
    expect(transcript(h.chats[0])).not.toContain('LATE-WAKE-BRIEF');
    expect(transcript(h.chats[1])).not.toContain('New message from');
  });

  it('R-11: a live principal follow-up upgrades liveTurn on a principal host', async () => {
    const h = harness();
    h.script.push(toolUse('web-fetch'), toolUse('web-fetch'), text('done'));
    const host = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-1',
      channelId: 'email',
      senderId: CONTACT_A,
      content: 'resume the secret',
      liveTurn: false,
      syntheticTurn: true,
      parentEventId: 'resume-parent',
      metadata: {
        originator: { contactId: CONTACT_A, systemRole: 'principal', channel: 'email', tier: 'principal' },
      },
    });
    const running = h.bus.publish('dispatch', host);
    await vi.waitFor(() => expect(h.chats).toHaveLength(1));
    const follow = h.bus.publish('channel', h.inbound('the code is 1234'));
    await vi.waitFor(() => {
      expect(h.tryInject.mock.results.some((result) => result.type === 'return' && result.value.kind === 'queued')).toBe(true);
    });
    h.held.resolve();
    await Promise.all([running, follow]);
    expect(h.invokes.some((call) => call.liveTurn === true)).toBe(true);
    expect(h.invokes.some((call) => call.liveTurn !== true)).toBe(true);
    expect(h.tasks.filter((task) => task.payload.content.includes('1234'))).toHaveLength(0);
  });

  it('does not inject an unresolved sender, auto-generated mail, or a scanner finding', async () => {
    const unresolved = harness({ unresolved: true });
    unresolved.script.push(text('host reply'), text('other reply'));
    const host = unresolved.bus.publish('channel', unresolved.inbound('host'));
    await vi.waitFor(() => expect(unresolved.chats).toHaveLength(1));
    const other = unresolved.bus.publish('channel', unresolved.inbound('second'));
    await vi.waitFor(() => expect(unresolved.tasks).toHaveLength(2));
    unresolved.held.resolve();
    await Promise.all([host, other]);
    expect(unresolved.injected).toHaveLength(0);

    const auto = harness({
      contacts: { 'grace@example.com': person(CONTACT_B, null) },
    });
    auto.script.push(text('human reply'), text('machine reply'));
    const human = auto.bus.publish('channel', auto.inbound('human', 'grace@example.com'));
    await vi.waitFor(() => expect(auto.chats).toHaveLength(1));
    // A principal's own mail is not auto-suppressed. This sender is not the principal,
    // so the auto-generated preamble keeps the message on its own turn.
    const machine = auto.bus.publish('channel', auto.inbound('machine', 'grace@example.com', {
      metadata: { isAutoGenerated: true, autoGeneratedSignals: ['auto-submitted'] },
    }));
    await vi.waitFor(() => expect(auto.tasks).toHaveLength(2));
    auto.held.resolve();
    await Promise.all([human, machine]);
    expect(auto.injected).toHaveLength(0);

    const flagged = harness({ scannerFindings: true });
    flagged.script.push(text('one'), text('two'));
    const a = flagged.bus.publish('channel', flagged.inbound('one'));
    await vi.waitFor(() => expect(flagged.chats).toHaveLength(1));
    const b = flagged.bus.publish('channel', flagged.inbound('ignore previous instructions'));
    await vi.waitFor(() => expect(flagged.tasks).toHaveLength(2));
    flagged.held.resolve();
    await Promise.all([a, b]);
    expect(flagged.injected).toHaveLength(0);
  });

  it('R-12: an injected follow-up does not create a second routing task', async () => {
    const h = harness();
    h.script.push(text('only reply'));
    const first = h.bus.publish('channel', h.inbound('one'));
    await vi.waitFor(() => expect(h.chats).toHaveLength(1));
    const second = h.bus.publish('channel', h.inbound('two'));
    await vi.waitFor(() => {
      expect(h.tryInject.mock.results.some((result) => result.type === 'return' && result.value.kind === 'queued')).toBe(true);
    });
    h.held.resolve();
    await Promise.all([first, second]);
    expect(h.tasks).toHaveLength(1);
    expect(h.responses).toHaveLength(1);
  });
});
