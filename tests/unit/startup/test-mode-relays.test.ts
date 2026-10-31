// Relayed replies in a recording stack (#2312): the dispatcher's outbound.message for a
// through-gateway run goes through the real EmailAdapter / SignalAdapter outbound path to the
// recording gateway, as production's does; a reply band review holds raises the approval and
// wakes the coordinator; every other run's relay stays on the bus, unsent.
import { describe, expect, it, vi } from 'vitest';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createOutboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { NylasMessage } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { BandSendReview } from '../../../src/dispatch/band-send-review.js';
import { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import { createLogger } from '../../../src/logger.js';
import { createRecordingOutboundGateway, subscribeRecordingRelays, type RecordedSend, type SendRecorder } from '../../../src/startup/test-mode-sends.js';

const logger = createLogger('error');

const inbound: NylasMessage = {
  id: 'scenario-msg-1', threadId: 'scenario-abc', subject: 'Booking', from: [{ email: 'bookings@acme-physio.test', name: 'Acme Bookings' }],
  to: [{ email: 'curia@example.test' }], cc: [], bcc: [], body: 'What number can we call?', snippet: '', date: 0, unread: true,
  folders: ['INBOX'], attachments: [],
  headers: [{ name: 'Authentication-Results', value: 'mx.example.test; spf=pass smtp.mailfrom=acme-physio.test; dkim=pass header.d=acme-physio.test; dmarc=pass header.from=acme-physio.test' }],
};

function setup(opts: { hold?: boolean; relays: (conversationId?: string) => boolean }) {
  const bus = new EventBus(logger);
  const sends: RecordedSend[] = [];
  const recorder: SendRecorder = {
    record: (send) => { sends.push(send); },
    message: (id) => (id === inbound.id ? inbound : undefined),
    threadMessages: (threadId) => (threadId === inbound.threadId ? [inbound] : []),
    relays: opts.relays,
    ownAddresses: ['curia@example.test'],
  };
  const rows: Array<Record<string, unknown>> = [];
  const actionLogRepo = {
    insert: vi.fn(async (row: Record<string, unknown>) => { rows.push(row); return rows.length; }),
    findApprovalNumber: async () => 7,
    insertSampled: async () => 0,
    linkPayload: async () => true,
  } as unknown as ActionLogRepo;
  const autonomy = { getConfig: async () => ({ score: 84, band: 'trusted', updatedAt: new Date(), updatedBy: 'test', gating: 'band' }) } as unknown as AutonomyService;
  const bandReview: Pick<BandSendReview, 'review'> = {
    review: async () => (opts.hold ? { kind: 'hold', reason: 'the reply shares the principal\'s phone', findings: [] } : { kind: 'send' }),
  };
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    getContact: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService;
  const gateway = createRecordingOutboundGateway({
    recorder,
    emailAccounts: [{ name: 'curia', selfEmail: 'curia@example.test' }],
    contactService,
    bus,
    logger,
    principalIdentities: [],
    autonomyService: autonomy,
    review: { contentFilter: new OutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '' }), actionLogRepo, bandReview, gating: 'band' },
  });
  gateway.setApprovalDelivery({ registerDisplay: () => {} });
  subscribeRecordingRelays({
    recorder, gateway, bus, logger, contactService,
    emailAccounts: [{ name: 'curia', selfEmail: 'curia@example.test' }],
    ownAddresses: ['curia@example.test'],
    principalEmail: { current: 'avery@example.test' },
    timezone: 'UTC',
  });
  const wakes: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'system', (event) => { wakes.push(event as AgentTaskEvent); });
  return { bus, sends, rows, wakes };
}

const relay = (conversationId: string, channelId: string, content: string) => createOutboundMessage({
  conversationId, channelId, content, taskEventId: 'task-1', parentEventId: 'response-1',
  ...(channelId === 'email' ? { accountId: 'curia' } : {}),
});

describe('subscribeRecordingRelays', () => {
  it('sends a through-gateway run\'s relayed email reply through the adapter path, as a recorded delivery', async () => {
    const { bus, sends } = setup({ relays: () => true });
    await bus.publish('dispatch', relay('email:scenario-abc', 'email', 'You can reach Avery at the office line.'));
    expect(sends).toEqual([expect.objectContaining({
      channel: 'email', kind: 'send', to: ['bookings@acme-physio.test'], subject: 'Re: Booking',
    })]);
    // The adapter's quote of the message it answers rides along.
    expect(sends[0]!.body).toContain('You can reach Avery at the office line.');
    expect(sends[0]!.body).toContain('What number can we call?');
  });

  it('sends a relayed Signal reply to the number the conversation names', async () => {
    const { bus, sends } = setup({ relays: () => true });
    await bus.publish('dispatch', relay('signal:+15555550142', 'signal', 'On my way.'));
    expect(sends).toEqual([expect.objectContaining({ channel: 'signal', kind: 'send', to: ['+15555550142'], body: 'On my way.' })]);
  });

  it('holds a relayed reply band review holds: an approval row, no delivery, and the coordinator woken to deliver it', async () => {
    const { bus, sends, rows, wakes } = setup({ hold: true, relays: () => true });
    await bus.publish('dispatch', relay('signal:+15555550142', 'signal', 'Avery\'s cell is 519-555-0186.'));
    expect(sends).toEqual([]);
    expect(rows).toEqual([expect.objectContaining({ outcome: 'pending_approval', conversationId: 'signal:+15555550142' })]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.payload.conversationId).toMatch(/^approval-delivery:/);
  });

  it('leaves every other run\'s relay on the bus, unsent', async () => {
    const { bus, sends, rows } = setup({ relays: () => false });
    await bus.publish('dispatch', relay('email:scenario-abc', 'email', 'Hello'));
    await bus.publish('dispatch', relay('signal:+15555550142', 'signal', 'Hello'));
    expect(sends).toEqual([]);
    expect(rows).toEqual([]);
  });
});
