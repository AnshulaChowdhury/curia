// make-room turn guidance through the dispatcher (#2227): only the principal's own words
// select it, so a quoted line or a refusal does not.

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { createLogger } from '../../../src/logger.js';

const principalResolver = {
  resolve: async () => ({
    resolved: true,
    contactId: 'principal-1',
    displayName: 'Principal',
    role: null,
    systemRole: 'principal',
    tier: 'principal',
    kind: 'person',
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 0.9,
  }),
} as unknown as ContactResolver;

async function guidanceFor(content: string): Promise<readonly string[]> {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  new Dispatcher({ bus, logger, contactResolver: principalResolver }).register();
  const tasks: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });
  await bus.publish('channel', createInboundMessage({
    conversationId: 'signal:+15551234567',
    channelId: 'signal',
    senderId: '+15551234567',
    content,
  }));
  expect(tasks).toHaveLength(1);
  return tasks[0]!.payload.turnGuidance ?? [];
}

describe('Dispatcher — make-room guidance (#2227)', () => {
  it('selects make-room for the principal\'s own request on Signal', async () => {
    expect(await guidanceFor('I can move my focus block so we can meet tomorrow')).toContain('make-room');
  });

  it('ignores a quoted request above the principal\'s own reply', async () => {
    expect(await guidanceFor('> I can move my focus block\nNo, leave it.')).not.toContain('make-room');
  });

  it('does not select make-room for a refusal', async () => {
    expect(await guidanceFor("Don't make room by moving my meetings; offer another day.")).not.toContain('make-room');
  });
});
