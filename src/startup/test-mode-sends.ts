// test-mode-sends.ts — the recording transports and gateway a test-mode stack can opt into
// (#2312). The scenario suite's `through_gateway` cases run send tools through production's
// OutboundGateway review: PII detection, the content filter, band review, holds and asks,
// outreach records. Only the last step differs: the transports are recording fakes, so a
// message that passes the review is handed to the run that sent it instead of a network.
//
// No-send by construction, as createNoSendOutboundGateway is:
//   - No real client class (NylasClient, SignalRpcClient, SlackClient, SmsClient) is ever
//     constructed here. The fakes are plain objects shaped like the methods the gateway calls.
//   - No outbound queue. A queued row would be flushed later by any real instance sharing the
//     database. The gateway is never start()ed, so it does not subscribe to channel.reconnect.
//   - A send with no run to record it fails: SendRecorder.record throws, and the gateway
//     reports a failed dispatch.

import { randomUUID } from 'node:crypto';
import type { NylasClient, NylasMessage, SendEmailOptions } from '../channels/email/nylas-client.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';
import type { SignalSendParams } from '../channels/signal/types.js';
import type { SlackClient } from '../channels/slack/slack-client.js';
import type { SlackPostMessageParams, SlackPostMessageResult } from '../channels/slack/types.js';
import type { SmsClient } from '../channels/sms/sms-client.js';
import type { ApprovalDisplay } from '../autonomy/approval-delivery.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { AutonomyService } from '../autonomy/autonomy-service.js';
import type { AutonomyGating } from '../autonomy/band-policy.js';
import type { RelayBudget } from '../autonomy/relay-budget.js';
import type { EventBus } from '../bus/bus.js';
import type { IdentityGateMode } from '../config.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { ChannelIdentity } from '../contacts/types.js';
import type { BandSendReview } from '../dispatch/band-send-review.js';
import type { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import type { PiiRedactor } from '../dispatch/pii-redactor.js';
import type { ConversationEntityState } from '../entity-context/conversation-entities.js';
import type { Logger } from '../logger.js';
import { OutboundGateway } from '../skills/outbound-gateway.js';
import type { AgentPersona } from '../skills/types.js';

/** One message a recording transport took: what would have left the process. */
export interface RecordedSend {
  channel: 'email' | 'signal' | 'slack' | 'sms';
  /** `draft`: an email draft was created and nothing left. `send`: delivered, a sent draft included. */
  kind: 'send' | 'draft';
  /** Addresses, numbers or Slack ids, as the gateway handed them to the transport. */
  to: string[];
  cc: string[];
  subject?: string;
  /** The text delivered. An email's HTML is reduced to its text. */
  body: string;
  /** The synthetic message (or draft) id the transport returned. */
  id: string;
}

/**
 * Where the recording transports put what they take. The scenario harness routes each call
 * to the run that made it, through the per-attempt case context.
 */
export interface SendRecorder {
  /** Take one message. Throw to refuse it (no run to record it): the gateway reports the send failed. */
  record(send: RecordedSend): void;
  /**
   * The message the fake mailbox returns for `messageId` (an email-reply's target, read by
   * Gate C and the handler), or undefined when the run has none: the fetch then fails as a
   * missing message does.
   */
  message(messageId: string): NylasMessage | undefined;
  /** What a held send will show the principal (ApprovalDelivery.registerDisplay). */
  display?(shortRef: string, display: ApprovalDisplay): void;
}

/** A fake mailbox's failure for an id it does not hold: the 404 Nylas returns. */
class ScenarioMailboxNotFound extends Error {
  readonly statusCode = 404;
  constructor(what: string) {
    super(`${what} not found in the test-mode mailbox`);
    this.name = 'ScenarioMailboxNotFound';
  }
}

/** An email body as text: tags dropped, the common entities decoded, whitespace collapsed. */
export function emailText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function addresses(list: SendEmailOptions['to'] | undefined): string[] {
  return (list ?? []).map(a => a.email);
}

export interface RecordingTransports {
  nylasClients: Map<string, NylasClient>;
  signalClient: SignalRpcClient;
  slackClient: SlackClient;
  smsClient: SmsClient;
}

/**
 * The fakes. Each is a plain object with the methods the gateway calls, cast to the client's
 * type at this one boundary: nothing here can open a socket or make a request. Draft contents
 * live in memory, keyed by a random id, so send-draft replays what createDraft stored.
 */
export function createRecordingTransports(recorder: SendRecorder, accountNames: readonly string[]): RecordingTransports {
  const drafts = new Map<string, NylasMessage>();
  const asMessage = (id: string, options: SendEmailOptions): NylasMessage => ({
    id,
    threadId: `scenario-thread-${id}`,
    subject: options.subject,
    from: [],
    to: options.to,
    cc: options.cc ?? [],
    bcc: [],
    body: options.body,
    snippet: emailText(options.body).slice(0, 120),
    date: Math.floor(Date.now() / 1000),
    unread: false,
    folders: [],
    attachments: [],
  });
  const emailSend = (kind: RecordedSend['kind'], message: NylasMessage): void => {
    recorder.record({
      channel: 'email',
      kind,
      to: addresses(message.to),
      cc: addresses(message.cc),
      subject: message.subject,
      body: emailText(message.body),
      id: message.id,
    });
  };

  const mailbox = {
    sendMessage: async (options: SendEmailOptions): Promise<NylasMessage> => {
      const message = asMessage(`scenario-sent-${randomUUID()}`, options);
      emailSend('send', message);
      return message;
    },
    createDraft: async (options: SendEmailOptions): Promise<NylasMessage> => {
      const draft = asMessage(`scenario-draft-${randomUUID()}`, options);
      emailSend('draft', draft);
      drafts.set(draft.id, draft);
      return draft;
    },
    getDraft: async (draftId: string): Promise<NylasMessage | null> => drafts.get(draftId) ?? null,
    sendDraft: async (draftId: string): Promise<NylasMessage> => {
      const draft = drafts.get(draftId);
      if (!draft) throw new ScenarioMailboxNotFound(`Draft ${draftId}`);
      drafts.delete(draftId);
      const sent = { ...draft, id: `scenario-sent-${randomUUID()}` };
      emailSend('send', sent);
      return sent;
    },
    getMessage: async (messageId: string): Promise<NylasMessage> => {
      const message = recorder.message(messageId);
      if (!message) throw new ScenarioMailboxNotFound(`Message ${messageId}`);
      return message;
    },
  };
  // Cast: the gateway calls only the methods above on a send path. Anything else (archive,
  // labels, attachments) is not a send and fails loudly instead of reaching a network.
  const nylasClient = mailbox as unknown as NylasClient;
  const names = accountNames.length > 0 ? accountNames : ['scenario'];
  const nylasClients = new Map(names.map(name => [name, nylasClient] as const));

  const signalClient = {
    isConnected: (): boolean => true,
    send: async (params: SignalSendParams): Promise<string> => {
      const id = String(Date.now());
      recorder.record({
        channel: 'signal',
        kind: 'send',
        to: params.recipient ?? (params.groupId ? [params.groupId] : []),
        cc: [],
        body: params.message,
        id,
      });
      return id;
    },
    listGroups: async (): Promise<[]> => [],
  } as unknown as SignalRpcClient;

  const slackClient = {
    isConnected: (): boolean => true,
    postMessage: async (params: SlackPostMessageParams): Promise<SlackPostMessageResult> => {
      const ts = `${Math.floor(Date.now() / 1000)}.${randomUUID().slice(0, 6)}`;
      recorder.record({ channel: 'slack', kind: 'send', to: [params.channel], cc: [], body: params.text, id: ts });
      return { ok: true, ts, channel: params.channel };
    },
  } as unknown as SlackClient;

  const smsClient = {
    sendSms: async (params: { to: string; text: string }): Promise<{ messageId: string }> => {
      const messageId = `scenario-sms-${randomUUID()}`;
      recorder.record({ channel: 'sms', kind: 'send', to: [params.to], cc: [], body: params.text, id: messageId });
      return { messageId };
    },
  } as unknown as SmsClient;

  return { nylasClients, signalClient, slackClient, smsClient };
}

/** Production's review, as the recording gateway takes it (built in createTestModeStack). */
export interface RecordingGatewayReview {
  contentFilter: OutboundContentFilter;
  piiRedactor?: PiiRedactor;
  bandReview?: Pick<BandSendReview, 'review'>;
  actionLogRepo?: ActionLogRepo;
  conversationEntities?: ConversationEntityState;
  identityGate?: IdentityGateMode;
  relayBudget?: RelayBudget;
  agentPersona?: AgentPersona;
  gating?: AutonomyGating;
}

/**
 * The OutboundGateway a recording stack builds: production's constructor and review, with the
 * recording transports in place of the network and no outbound queue. Exported so the no-send
 * guarantee can be unit-tested without a database.
 */
export function createRecordingOutboundGateway(deps: {
  recorder: SendRecorder;
  /** Each mailbox's name and own address (email_accounts), as production keys its clients. */
  emailAccounts: ReadonlyArray<{ name: string; selfEmail: string }>;
  /** Curia's Signal number, the `account` of a Signal send. */
  signalPhoneNumber?: string;
  contactService: ContactService;
  bus: EventBus;
  logger: Logger;
  principalIdentities: ChannelIdentity[];
  autonomyService?: AutonomyService;
  review: RecordingGatewayReview;
}): OutboundGateway {
  const transports = createRecordingTransports(deps.recorder, deps.emailAccounts.map(a => a.name));
  const { review } = deps;
  return new OutboundGateway({
    nylasClients: transports.nylasClients,
    emailAccountAddresses: new Map(deps.emailAccounts.map(a => [a.name, a.selfEmail])),
    ...(review.agentPersona ? { agentPersona: review.agentPersona } : {}),
    signalClient: transports.signalClient,
    // A placeholder in the 555 range when the vault has no number: it is only the `account`
    // the fake Signal client is handed.
    signalPhoneNumber: deps.signalPhoneNumber ?? '+15555550100',
    slackClient: transports.slackClient,
    smsClient: transports.smsClient,
    contactService: deps.contactService,
    contentFilter: review.contentFilter,
    bus: deps.bus,
    principalIdentities: deps.principalIdentities,
    ...(review.conversationEntities ? { conversationEntities: review.conversationEntities } : {}),
    ...(review.identityGate ? { identityGate: review.identityGate } : {}),
    logger: deps.logger,
    autonomyService: deps.autonomyService,
    ...(review.piiRedactor ? { piiRedactor: review.piiRedactor } : {}),
    ...(review.actionLogRepo ? { actionLogRepo: review.actionLogRepo } : {}),
    // No outboundQueue and no readiness probes: nothing is ever deferred to a later flush,
    // which a real instance sharing the database would perform with real transports.
    gating: review.gating ?? 'tier',
    ...(review.bandReview ? { bandReview: review.bandReview } : {}),
    ...(review.relayBudget ? { relayBudget: review.relayBudget } : {}),
  });
}
