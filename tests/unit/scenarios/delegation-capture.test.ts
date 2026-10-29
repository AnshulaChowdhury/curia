// What real specialists did in a scenario run, read off the bus (#2027).
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import {
  createAgentError,
  createAgentResponse,
  createAgentTask,
  createToolInvoke,
  createToolResult,
} from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { createDelegationCapture, inRunOrder } from '../../scenarios/delegation-capture.js';

const ROOT = 'scenario-1';
const SPECIALIST = 'scenario-delegate-a';

function setup() {
  const bus = new EventBus(createLogger('error'));
  // The stub layer's view: the specialist's conversation belongs to the run while it is open.
  const open = new Set([ROOT, SPECIALIST]);
  const late = vi.fn();
  const capture = createDelegationCapture(bus, conv => (open.has(conv) ? ROOT : undefined), late);
  const invoke = async (agentId: string, conversationId: string, toolName: string) => {
    const event = createToolInvoke({ agentId, conversationId, toolName, input: { q: toolName }, taskEventId: 't', parentEventId: 't' });
    await bus.publish('agent', event);
    return event;
  };
  return { bus, capture, open, late, invoke };
}

describe('createDelegationCapture', () => {
  it('records a specialist\'s brief, calls and response, and the run\'s call order', async () => {
    const { bus, capture, invoke } = setup();
    capture.begin(ROOT);
    const coordinatorDelegate = await invoke('coordinator', ROOT, 'delegate');
    const task = createAgentTask({
      agentId: 'calendar', conversationId: SPECIALIST, channelId: 'internal', senderId: 'coordinator',
      content: 'Message ID: m-1\n\nWhat is on tomorrow?', parentEventId: 'delegate-x',
    });
    await bus.publish('dispatch', task);
    const read = await invoke('calendar', SPECIALIST, 'calendar-list-events');
    await bus.publish('execution', createToolResult({
      agentId: 'calendar', conversationId: SPECIALIST, toolName: 'calendar-list-events',
      result: { success: true, data: { count: 0 } }, durationMs: 1, parentEventId: read.id,
    }));
    await bus.publish('agent', createAgentResponse({ agentId: 'calendar', conversationId: SPECIALIST, content: 'Nothing on.', parentEventId: task.id }));
    const coordinatorReply = await invoke('coordinator', ROOT, 'memory-query');

    const trace = capture.end(ROOT);
    expect(trace.delegations).toEqual([{
      agentId: 'calendar', conversationId: SPECIALIST, brief: 'Message ID: m-1\n\nWhat is on tomorrow?',
      response: 'Nothing on.', outcome: 'answered',
    }]);
    expect(trace.calls).toEqual([expect.objectContaining({
      agentId: 'calendar', name: 'calendar-list-events', invokeEventId: read.id, result: { success: true, data: { count: 0 } },
    })]);
    // The coordinator's own calls are only numbered: turn capture records them.
    expect(trace.seqByInvoke.get(coordinatorDelegate.id)).toBeLessThan(trace.seqByInvoke.get(read.id)!);
    expect(trace.seqByInvoke.get(read.id)).toBeLessThan(trace.seqByInvoke.get(coordinatorReply.id)!);

    const ordered = inRunOrder([
      { name: 'delegate', input: {}, invokeEventId: coordinatorDelegate.id },
      { name: 'memory-query', input: {}, invokeEventId: coordinatorReply.id },
    ], trace);
    expect(ordered.map(c => `${c.agentId}:${c.name}`)).toEqual([
      'coordinator:delegate', 'calendar:calendar-list-events', 'coordinator:memory-query',
    ]);
  });

  it('marks a specialist error, and one still working when the run ends', async () => {
    const { bus, capture } = setup();
    capture.begin(ROOT);
    await bus.publish('dispatch', createAgentTask({ agentId: 'calendar', conversationId: SPECIALIST, channelId: 'internal', senderId: 'coordinator', content: 'brief', parentEventId: 'd' }));
    expect(capture.end(ROOT).delegations[0]).toMatchObject({ outcome: 'in_flight', response: null });

    capture.begin(ROOT);
    await bus.publish('dispatch', createAgentTask({ agentId: 'calendar', conversationId: SPECIALIST, channelId: 'internal', senderId: 'coordinator', content: 'brief', parentEventId: 'd' }));
    await bus.publish('agent', createAgentError({ agentId: 'calendar', conversationId: SPECIALIST, errorType: 'PROVIDER_ERROR', source: 'x', message: 'boom', retryable: true, context: {}, parentEventId: 'd' }));
    expect(capture.end(ROOT).delegations[0]).toMatchObject({ outcome: 'error', response: 'agent.error PROVIDER_ERROR: boom' });
  });

  it('ignores the run\'s own conversation and anything outside an open run', async () => {
    const { bus, capture } = setup();
    capture.begin(ROOT);
    await bus.publish('dispatch', createAgentTask({ agentId: 'coordinator', conversationId: ROOT, channelId: 'cli', senderId: 'p', content: 'hi', parentEventId: 'x' }));
    await bus.publish('dispatch', createAgentTask({ agentId: 'calendar', conversationId: 'delegate-elsewhere', channelId: 'internal', senderId: 'coordinator', content: 'x', parentEventId: 'x' }));
    expect(capture.end(ROOT).delegations).toEqual([]);
  });

  // An approval wake (or `inbound.then` turn) is filed under the run, as the stub layer does;
  // a specialist in the same run must still be recorded whole.
  function setupWithFollowOn() {
    const bus = new EventBus(createLogger('error'));
    const WAKE = 'approval-delivery:1';
    const open = new Set([ROOT, SPECIALIST, WAKE]);
    const late = vi.fn();
    const capture = createDelegationCapture(bus, conv => (open.has(conv) ? ROOT : undefined), late, conv => conv === WAKE);
    const invoke = async (agentId: string, conversationId: string, toolName: string) => {
      const event = createToolInvoke({ agentId, conversationId, toolName, input: {}, taskEventId: 't', parentEventId: 't' });
      await bus.publish('agent', event);
      return event;
    };
    const wakeTask = createAgentTask({ agentId: 'coordinator', conversationId: WAKE, channelId: 'internal', senderId: 'system', content: 'deliver it', parentEventId: 'w' });
    return { bus, capture, open, late, invoke, WAKE, wakeTask };
  }

  it('numbers a follow-on turn\'s calls but records neither them nor its task, and keeps a specialist\'s', async () => {
    const { bus, capture, invoke, WAKE, wakeTask } = setupWithFollowOn();
    capture.begin(ROOT);
    const first = await invoke('coordinator', ROOT, 'memory-query');
    const task = createAgentTask({ agentId: 'calendar', conversationId: SPECIALIST, channelId: 'internal', senderId: 'coordinator', content: 'brief', parentEventId: 'd' });
    await bus.publish('dispatch', task);
    const read = await invoke('calendar', SPECIALIST, 'calendar-list-events');
    await bus.publish('execution', createToolResult({
      agentId: 'calendar', conversationId: SPECIALIST, toolName: 'calendar-list-events',
      result: { success: true, data: { count: 0 } }, durationMs: 1, parentEventId: read.id,
    }));
    await bus.publish('agent', createAgentResponse({ agentId: 'calendar', conversationId: SPECIALIST, content: 'Nothing on.', parentEventId: task.id }));
    await bus.publish('dispatch', wakeTask);
    const wake = await invoke('coordinator', WAKE, 'deliver-approval');

    const trace = capture.end(ROOT);
    // Turn capture records the wake's calls; kept here too, they were counted twice (#2346).
    expect(trace.calls).toEqual([expect.objectContaining({
      agentId: 'calendar', name: 'calendar-list-events', invokeEventId: read.id, result: { success: true, data: { count: 0 } },
    })]);
    expect(trace.delegations).toEqual([{ agentId: 'calendar', conversationId: SPECIALIST, brief: 'brief', response: 'Nothing on.', outcome: 'answered' }]);
    expect(trace.seqByInvoke.get(first.id)).toBeLessThan(trace.seqByInvoke.get(wake.id)!);
    // Handed back by turn capture, they sort into run order whatever order they arrive in.
    const ordered = inRunOrder([
      { name: 'deliver-approval', input: {}, invokeEventId: wake.id, agentId: 'coordinator' },
      { name: 'memory-query', input: {}, invokeEventId: first.id },
    ], trace);
    expect(ordered.map(c => `${c.agentId}:${c.name}`)).toEqual([
      'coordinator:memory-query', 'calendar:calendar-list-events', 'coordinator:deliver-approval',
    ]);
  });

  it('reports a follow-on turn still running when its run ended, and not one that finished in time', async () => {
    const { bus, capture, open, late, WAKE, wakeTask } = setupWithFollowOn();
    capture.begin(ROOT);
    await bus.publish('dispatch', wakeTask);
    capture.end(ROOT);
    open.clear(); // the stub layer closed the run
    await bus.publish('agent', createAgentResponse({ agentId: 'coordinator', conversationId: WAKE, content: 'late', parentEventId: wakeTask.id }));
    expect(late).toHaveBeenCalledWith(WAKE);

    late.mockClear();
    [ROOT, SPECIALIST, WAKE].forEach(c => open.add(c));
    capture.begin(ROOT);
    await bus.publish('dispatch', wakeTask);
    await bus.publish('agent', createAgentResponse({ agentId: 'coordinator', conversationId: WAKE, content: 'done', parentEventId: wakeTask.id }));
    capture.end(ROOT);
    open.clear();
    await bus.publish('agent', createAgentError({ agentId: 'coordinator', conversationId: WAKE, errorType: 'PROVIDER_ERROR', source: 'x', message: 'x', retryable: true, context: {}, parentEventId: 'w' }));
    expect(late).not.toHaveBeenCalled();
  });

  it('reports a specialist that finishes after its run ended, for another cleanup', async () => {
    const { bus, capture, open, late } = setup();
    capture.begin(ROOT);
    const task = createAgentTask({ agentId: 'calendar', conversationId: SPECIALIST, channelId: 'internal', senderId: 'coordinator', content: 'brief', parentEventId: 'd' });
    await bus.publish('dispatch', task);
    capture.end(ROOT);
    open.clear(); // the stub layer closed the run
    await bus.publish('agent', createAgentResponse({ agentId: 'calendar', conversationId: SPECIALIST, content: 'late', parentEventId: task.id }));
    expect(late).toHaveBeenCalledWith(SPECIALIST);
  });
});

describe('inRunOrder', () => {
  it('tags the coordinator\'s calls and keeps their order when no specialist ran', () => {
    const calls = [{ name: 'a', input: {} }, { name: 'b', input: {} }];
    expect(inRunOrder(calls, undefined)).toEqual([{ name: 'a', input: {}, agentId: 'coordinator' }, { name: 'b', input: {}, agentId: 'coordinator' }]);
    expect(inRunOrder(calls, { seqByInvoke: new Map(), calls: [] }).map(c => c.name)).toEqual(['a', 'b']);
  });

  it('orders by the trace\'s numbering even when no specialist call was kept', () => {
    // A follow-on turn's calls arrive after the first turn's but may have been made between them.
    const calls = [{ name: 'a', input: {}, invokeEventId: 'i-a' }, { name: 'b', input: {}, invokeEventId: 'i-b' }];
    const trace = { seqByInvoke: new Map([['i-a', 2], ['i-b', 1]]), calls: [] };
    expect(inRunOrder(calls, trace).map(c => c.name)).toEqual(['b', 'a']);
  });
});
