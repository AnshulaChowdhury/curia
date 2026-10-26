// The recording gateway's no-send guarantee (#2312, Review Focus 3). A through-gateway
// scenario send runs production's gateway review, then reaches recording fakes: no real
// client class is ever constructed, there is no outbound queue (so no flush path), and a
// send no run records fails instead of going anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constructed = vi.hoisted(() => ({ clients: [] as string[] }));

// Every real transport, and the queue, record their construction. None may happen.
vi.mock('../../../src/channels/email/nylas-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/email/nylas-client.js')>();
  return { ...mod, NylasClient: vi.fn(function NylasClient() { constructed.clients.push('NylasClient'); }) };
});
vi.mock('../../../src/channels/signal/signal-rpc-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/signal/signal-rpc-client.js')>();
  return { ...mod, SignalRpcClient: vi.fn(function SignalRpcClient() { constructed.clients.push('SignalRpcClient'); }) };
});
vi.mock('../../../src/channels/slack/slack-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/slack/slack-client.js')>();
  return { ...mod, SlackClient: vi.fn(function SlackClient() { constructed.clients.push('SlackClient'); }) };
});
vi.mock('../../../src/channels/sms/sms-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/sms/sms-client.js')>();
  return { ...mod, SmsClient: vi.fn(function SmsClient() { constructed.clients.push('SmsClient'); }) };
});
vi.mock('../../../src/skills/outbound-queue-repo.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/skills/outbound-queue-repo.js')>();
  return { ...mod, OutboundQueueRepo: vi.fn(function OutboundQueueRepo() { constructed.clients.push('OutboundQueueRepo'); }) };
});

import { EventBus } from '../../../src/bus/bus.js';
import { parseSenderVerified } from '../../../src/channels/email/message-converter.js';
import type { NylasMessage } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import { createLogger } from '../../../src/logger.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import {
  createRecordingOutboundGateway,
  createRecordingTransports,
  emailText,
  type RecordedSend,
  type SendRecorder,
} from '../../../src/startup/test-mode-sends.js';

const logger = createLogger('error');

/** A recorder for one run: what it took, and the inbound message its mailbox serves. */
function runRecorder(inbound?: NylasMessage): SendRecorder & { sends: RecordedSend[] } {
  const sends: RecordedSend[] = [];
  return {
    sends,
    record: (send) => { sends.push(send); },
    message: (id) => (inbound && inbound.id === id ? inbound : undefined),
  };
}

/** Outside every run: the harness's recorder refuses. */
const noRun: SendRecorder = {
  record: () => { throw new Error('a send outside every scenario run'); },
  message: () => undefined,
};

function gateway(recorder: SendRecorder): OutboundGateway {
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    getContact: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService;
  return createRecordingOutboundGateway({
    recorder,
    emailAccounts: [{ name: 'curia', selfEmail: 'curia@example.test' }],
    contactService,
    bus: new EventBus(logger),
    logger,
    principalIdentities: [],
    review: { contentFilter: new OutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '' }) },
  });
}

describe('createRecordingOutboundGateway', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    constructed.clients.length = 0;
    // Any network call would go through fetch (Nylas SDK, Slack, Telnyx). Make it loud.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
  });
  afterEach(() => {
    // No real client and no queue, whatever the test did.
    expect(constructed.clients).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('has no outbound queue, so nothing can be deferred to a later flush', async () => {
    const gw = gateway(runRecorder());
    expect((gw as unknown as { outboundQueue?: unknown }).outboundQueue).toBeUndefined();
    // start() subscribes the flush only when a queue exists.
    const subscribe = vi.spyOn(EventBus.prototype, 'subscribe');
    gw.start();
    expect(subscribe).not.toHaveBeenCalled();
    subscribe.mockRestore();
    expect(await gw.flushChannel('email')).toEqual({ flushed: 0, skipped: true });
  });

  it('records an email send as text, to the run that made it', async () => {
    const recorder = runRecorder();
    const result = await gateway(recorder).send(
      { channel: 'email', to: 'pat@vendor.example.test', cc: ['lee@vendor.example.test'], subject: 'Hi', body: 'Hello **there** & welcome' },
      { humanApproved: true },
    );
    expect(result.success).toBe(true);
    expect(recorder.sends).toHaveLength(1);
    const [sent] = recorder.sends;
    expect(sent).toMatchObject({ channel: 'email', kind: 'send', to: ['pat@vendor.example.test'], cc: ['lee@vendor.example.test'], subject: 'Hi' });
    expect(sent!.body).toContain('Hello there & welcome');
    expect(result.messageId).toBe(sent!.id);
  });

  it('records a Signal send', async () => {
    const recorder = runRecorder();
    const result = await gateway(recorder).send(
      { channel: 'signal', recipient: '+15555550123', message: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(true);
    expect(recorder.sends).toEqual([expect.objectContaining({ channel: 'signal', kind: 'send', to: ['+15555550123'], body: 'Hello' })]);
  });

  it('fails a send no run records, without touching the network', async () => {
    const result = await gateway(noRun).send(
      { channel: 'email', to: 'pat@vendor.example.test', subject: 'Hi', body: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(false);
  });

  it('keeps a draft unsent until send-draft sends it', async () => {
    const recorder = runRecorder();
    const gw = gateway(recorder);
    const draft = await gw.createEmailDraft({ channel: 'email', to: 'pat@vendor.example.test', subject: 'Hi', body: 'Draft body' });
    expect(draft.success).toBe(true);
    expect(recorder.sends.map(s => s.kind)).toEqual(['draft']);
  });
});

describe('createRecordingTransports', () => {
  it('serves the run\'s inbound message, and a 404 for any other id', async () => {
    const inbound: NylasMessage = {
      id: 'scenario-msg-1', threadId: 't1', subject: 'Quote', from: [{ email: 'pat@vendor.example.test' }],
      to: [{ email: 'curia@example.test' }], cc: [], bcc: [], body: 'Hi', snippet: 'Hi', date: 0, unread: false,
      folders: [], attachments: [],
      headers: [{ name: 'Authentication-Results', value: 'mx.example.test; spf=pass smtp.mailfrom=vendor.example.test; dkim=pass header.d=vendor.example.test; dmarc=pass header.from=vendor.example.test' }],
    };
    const { nylasClients } = createRecordingTransports(runRecorder(inbound), ['curia']);
    const mailbox = nylasClients.get('curia')!;
    const read = await mailbox.getMessage('scenario-msg-1', { includeHeaders: true });
    expect(read.id).toBe('scenario-msg-1');
    expect(parseSenderVerified(read.headers)).toBe(true);
    await expect(mailbox.getMessage('other')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sends a stored draft as written, once', async () => {
    const recorder = runRecorder();
    const mailbox = createRecordingTransports(recorder, ['curia']).nylasClients.get('curia')!;
    const draft = await mailbox.createDraft({ to: [{ email: 'pat@vendor.example.test' }], subject: 'S', body: '<p>Body</p>' });
    expect(await mailbox.getDraft(draft.id)).toMatchObject({ subject: 'S' });
    await mailbox.sendDraft(draft.id);
    expect(recorder.sends.map(s => [s.kind, s.body])).toEqual([['draft', 'Body'], ['send', 'Body']]);
    await expect(mailbox.sendDraft(draft.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keys one fake mailbox by every account name', () => {
    const { nylasClients } = createRecordingTransports(runRecorder(), ['curia', 'principal']);
    expect([...nylasClients.keys()]).toEqual(['curia', 'principal']);
  });
});

describe('emailText', () => {
  it('reduces HTML to its text', () => {
    expect(emailText('<p>Hi &amp; bye</p><p>Line&nbsp;2<br>3</p>')).toBe('Hi & bye\nLine 2\n3');
  });
});
