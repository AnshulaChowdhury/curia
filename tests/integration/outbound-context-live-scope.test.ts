// tests/integration/outbound-context-live-scope.test.ts
//
// #2261: a contact's own turn can reply to that contact, so its outbound-context block must
// hold only the messages sent to them, never another contact's reply or Curia's own notes.
// Runs the real Dispatcher and OutboundContextService against Postgres; only the contact
// resolver is a stand-in, answering for contact B. The task-wake twin of this test is
// outbound-context-wake-scope.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EventBus } from '../../src/bus/bus.js';
import { createInboundMessage } from '../../src/bus/events.js';
import type { AgentTaskEvent } from '../../src/bus/events.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { InboundSenderContext } from '../../src/contacts/types.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('a contact\'s live turn sees only what was sent to them (#2261)', () => {
  let pool: pg.Pool;
  let service: OutboundContextService;
  let dbVerified = false;
  const conversationId = `test-live-scope-${randomUUID()}`;
  const contactA = randomUUID();
  const contactB = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    service = new OutboundContextService(pool, createSilentLogger());
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [conversationId]);
    }
    await pool.end();
  });

  /** Publish one Signal message from contact B through a real Dispatcher; returns the coordinator's task. */
  async function sendFromB(content: string, metadata: Record<string, unknown>): Promise<AgentTaskEvent> {
    const logger = createSilentLogger();
    const bus = new EventBus(logger);
    const resolver = {
      resolve: async (): Promise<InboundSenderContext> => ({
        resolved: true, contactId: contactB, displayName: 'Contact B', role: null, systemRole: null,
        tier: 'known', kind: 'person', verified: true, kgNodeId: null, knowledgeSummary: '',
        authorization: null, contactConfidence: 0.9,
      }),
    } as unknown as ContactResolver;
    new Dispatcher({ bus, logger, contactResolver: resolver, outboundContextService: service }).register();
    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: `signal:+1555${randomUUID().replace(/-/g, '').slice(0, 7)}`,
      channelId: 'signal',
      senderId: '+15555550123',
      content,
      metadata,
    }));
    if (tasks.length !== 1) throw new Error(`expected one agent.task, got ${tasks.length}`);
    return tasks[0]!;
  }

  /** Seed: a send to A alone that A answered, and a send to both that A answered too. */
  async function seed(agentId: string): Promise<{ toA: string; toBoth: string }> {
    const register = (content: string, to: string[]) => service.register({
      conversationId, channelId: 'signal', agentId, content, expiresInHours: 1, recipientContactIds: to,
      expectedReply: 'CURIA-NOTE: do not tell B that A declined',
      delegationHint: 'coordinator: CURIA-HINT finish the decline to A',
      metadata: { note: 'CURIA-METADATA about A' },
    });
    const toA = await register('A-ONLY-ASK: does Thu Nov 5 work?', [contactA]);
    await service.recordReply([toA], { from: 'Contact A', contactId: contactA, content: 'A-PRIVATE-ANSWER Thur Nov 5' });
    const toBoth = await register('SHARED-ASK: lunch at Wildcraft?', [contactA, contactB]);
    await service.recordReply([toBoth], { from: 'Contact A', contactId: contactA, content: 'A-SHARED-ENTRY-ANSWER' });
    return { toA, toBoth };
  }

  it('shows B the entry sent to both, without A\'s replies, A\'s entry or Curia\'s notes', async () => {
    const { toA, toBoth } = await seed(`coordinator-${randomUUID()}`);

    const task = await sendFromB('B works for me', { isGroup: false });
    const content = task.payload.content;
    expect(content).toContain(toBoth);
    expect(content).toContain('SHARED-ASK');
    expect(content).toContain('B works for me');
    for (const hidden of [toA, 'A-ONLY-ASK', 'A-PRIVATE-ANSWER', 'A-SHARED-ENTRY-ANSWER', 'CURIA-NOTE', 'CURIA-HINT', 'CURIA-METADATA']) {
      expect(content).not.toContain(hidden);
    }

    // B's message is recorded on the entry B was shown, and on nothing sent only to A.
    const shared = await service.getEntry(toBoth);
    expect(shared?.recipientMessages.map((m) => m.contactId)).toEqual([contactA, contactB]);
    expect((await service.getEntry(toA))?.recipientMessages.map((m) => m.contactId)).toEqual([contactA]);
  });

  it('shows B nothing, and records nothing, in a Signal group', async () => {
    const { toBoth } = await seed(`coordinator-${randomUUID()}`);

    const task = await sendFromB('GROUP-MESSAGE from B', { isGroup: true });
    expect(task.payload.content).not.toContain('ACTIVE OUTBOUND CONTEXT');
    expect(task.payload.content).not.toContain('SHARED-ASK');
    expect((await service.getEntry(toBoth))?.recipientMessages.map((m) => m.contactId)).toEqual([contactA]);
  });
});
