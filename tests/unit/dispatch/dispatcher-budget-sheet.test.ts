// The attached-spreadsheet note (ADR-065): only on the principal's own web turns in a chat with a sheet attached.

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { createLogger } from '../../../src/logger.js';

const resolver = (systemRole: string | null) => ({
  resolve: async () => ({
    resolved: true, contactId: 'c-1', displayName: 'Person', role: null, systemRole, tier: systemRole ?? 'known', kind: 'person',
    verified: true, kgNodeId: null, knowledgeSummary: '', authorization: null, contactConfidence: 0.9,
  }),
}) as unknown as ContactResolver;

async function turn(channelId: string, systemRole: string | null, lookup: (id: string) => Promise<boolean>) {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  new Dispatcher({ bus, logger, contactResolver: resolver(systemRole), attachedBudgetSheet: lookup }).register();
  const tasks: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });
  await bus.publish('channel', createInboundMessage({ conversationId: 'chat-1', channelId, senderId: 'ceo-web-user', content: 'What does my sheet say about rent?' }));
  expect(tasks).toHaveLength(1);
  return tasks[0]!.payload.turnGuidance ?? [];
}

describe('Dispatcher — attached budget sheet', () => {
  it('adds the note on the principal\'s web turn when a sheet is attached', async () => {
    const lookup = vi.fn(async () => true);
    expect(await turn('web', 'principal', lookup)).toContain('budget-sheet-attached');
    expect(lookup).toHaveBeenCalledWith('chat-1');
  });

  it('does not, with nothing attached', async () => {
    expect(await turn('web', 'principal', async () => false)).not.toContain('budget-sheet-attached');
  });

  it('does not even look on another channel or for another sender', async () => {
    for (const [channel, role] of [['signal', 'principal'], ['web', null]] as const) {
      const lookup = vi.fn(async () => true);
      expect(await turn(channel, role, lookup)).not.toContain('budget-sheet-attached');
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it('runs the turn without the note when the lookup fails', async () => {
    expect(await turn('web', 'principal', async () => { throw new Error('down'); })).not.toContain('budget-sheet-attached');
  });
});
