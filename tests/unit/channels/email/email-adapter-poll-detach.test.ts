// The email poll must return after the Nylas fetch and handoff. A slow
// inbound subscriber is the agent turn; it must not hold the health stamp,
// the next poll, or a different thread (#2254).

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { EmailAdapter } from '../../../../src/channels/email/email-adapter.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import {
  createOutboundMessage,
  type BusEvent,
  type ChannelPollEvent,
} from '../../../../src/bus/events.js';
import { checkEmail } from '../../../../src/health/health-checks.js';

const SELF_EMAIL = 'curia@example.com';
const CEO_EMAIL = 'ceo@example.com';

function makeMockMessage(overrides: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-abc',
    subject: 'Hello',
    from: [{ email: CEO_EMAIL, name: 'CEO' }],
    to: [{ email: SELF_EMAIL, name: 'Curia' }],
    cc: [],
    bcc: [],
    body: '<p>Hi</p>',
    snippet: 'Hi',
    date: 1700000000,
    unread: true,
    folders: ['INBOX'],
    attachments: [],
    ...overrides,
  };
}

function createMocks() {
  const logger = createSilentLogger();
  const bus = {
    subscribe: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue({ id: 'existing' }),
  } as unknown as ContactService;
  const outboundGateway = {
    send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-1' }),
    createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-1' }),
    linkGatedAction: vi.fn().mockResolvedValue(undefined),
    listEmailMessages: vi.fn().mockResolvedValue([]),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as OutboundGateway;
  return { logger, bus, contactService, outboundGateway };
}

function makeAdapter(
  mocks: ReturnType<typeof createMocks>,
  overrides: Partial<{
    maxConcurrentTurns: number;
    pollingIntervalMs: number;
    suppressedSenderEmails: string[];
    logger: ReturnType<typeof createMocks>['logger'];
  }> = {},
) {
  return new EmailAdapter({
    accountId: 'curia',
    bus: mocks.bus,
    logger: overrides.logger ?? mocks.logger,
    outboundGateway: mocks.outboundGateway,
    contactService: mocks.contactService,
    pollingIntervalMs: overrides.pollingIntervalMs ?? 7_200_000,
    selfEmail: SELF_EMAIL,
    suppressedSenderEmails: overrides.suppressedSenderEmails ?? [],
    contactCreationMaxPerMessage: 10,
    contactCreationMaxPerHour: 100,
    ceoEmail: CEO_EMAIL,
    timezone: 'America/Toronto',
    ...(overrides.maxConcurrentTurns !== undefined
      ? { maxConcurrentTurns: overrides.maxConcurrentTurns }
      : {}),
  });
}

function pollNow(adapter: EmailAdapter): Promise<void> {
  return (adapter as unknown as { poll(): Promise<void> }).poll();
}

function inboundId(event: BusEvent): string | undefined {
  if (event.type !== 'inbound.message') return undefined;
  const id = event.payload.metadata?.nylasMessageId;
  return typeof id === 'string' ? id : undefined;
}

function pollEvents(bus: EventBus): ChannelPollEvent[] {
  return (bus.publish as ReturnType<typeof vi.fn>).mock.calls
    .map((args) => args[1] as BusEvent)
    .filter((event): event is ChannelPollEvent => event.type === 'channel.poll');
}

/** Hang each inbound publish until release(id). Other events resolve immediately. */
function hangInbound(bus: EventBus): { started: string[]; release: (id: string) => void } {
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  (bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
    const id = inboundId(event);
    if (!id) return Promise.resolve();
    started.push(id);
    return new Promise<void>((resolve) => {
      gates.set(id, resolve);
    });
  });
  return {
    started,
    release(id: string) {
      const resolve = gates.get(id);
      if (!resolve) throw new Error(`no in-flight publish for ${id}`);
      gates.delete(id);
      resolve();
    },
  };
}

function captureHandler(eventType: string, mocks: ReturnType<typeof createMocks>) {
  const handlers: Record<string, (event: BusEvent) => Promise<void>> = {};
  (mocks.bus.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
    (et: string, _layer: string, cb: (event: BusEvent) => Promise<void>) => {
      handlers[et] = cb;
    },
  );
  return (event: BusEvent) => {
    const handler = handlers[eventType];
    if (!handler) throw new Error(`${eventType} handler not registered`);
    return handler(event);
  };
}

function collectLogs(): { logger: pino.Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString().trim();
      if (line) entries.push(JSON.parse(line) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), entries };
}

function failureLogs(entries: Array<Record<string, unknown>>) {
  return entries.filter((entry) => entry.msg === 'Failed to process inbound email — skipping message');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EmailAdapter — poll does not wait for the agent turn (#2254)', () => {
  it('returns, stamps health, and emits channel.poll while a subscriber is still running', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    const started: string[] = [];
    let settled = false;
    let releaseTurn: () => void = () => {};
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
      const id = inboundId(event);
      if (!id) return Promise.resolve();
      started.push(id);
      return new Promise<void>((resolve) => {
        releaseTurn = () => {
          settled = true;
          resolve();
        };
      });
    });
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      makeMockMessage({ id: 'slow', threadId: 'thread-slow', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();

    expect(settled).toBe(false);
    expect(started).toEqual(['slow']);
    expect(adapter.lastSuccessfulPollAt).not.toBeNull();
    expect(checkEmail(adapter, 3, new Date())).toBe('ok');

    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.fetched).toBe(1);
    expect(audit[0]!.payload.processed).toBe(1);
    expect(audit[0]!.payload.skipped.failed).toBe(0);
    expect(audit[0]!.payload.durationMs).toBeLessThan(1_000);

    releaseTurn();
    await adapter.drainInFlight();
    expect(settled).toBe(true);
    await adapter.stop();
  });

  it('stays email-ok through a turn longer than the stall window, and fails when Nylas stops', async () => {
    vi.useFakeTimers();
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { pollingIntervalMs: 1_000 });
    let releaseTurn: () => void = () => {};
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
      if (event.type !== 'inbound.message') return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
    });
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      makeMockMessage({ id: 'long-turn', threadId: 'thread-long', from: [{ email: 'ada@example.com' }] }),
    ]).mockResolvedValue([]);

    try {
      await adapter.start();
      const stampedAtStart = adapter.lastSuccessfulPollAt!.getTime();

      // 3 × 1000ms is the health grace. Polls keep succeeding while the turn hangs,
      // so the stamp moves forward and the check stays ok.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(list.mock.calls.length).toBeGreaterThan(1);
      const fresh = adapter.lastSuccessfulPollAt!.getTime();
      expect(fresh).toBeGreaterThan(stampedAtStart);
      expect(checkEmail(adapter, 3, new Date(stampedAtStart))).toBe('ok');

      list.mockRejectedValue(new Error('Nylas unavailable'));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(adapter.lastSuccessfulPollAt!.getTime()).toBe(fresh);
      expect(checkEmail(adapter, 3, new Date(stampedAtStart))).toBe('fail');
    } finally {
      releaseTurn();
      await adapter.drainInFlight();
      await adapter.stop();
    }
  });

  it('starts a second thread without waiting for the first turn', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'a', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
      makeMockMessage({ id: 'b', threadId: 'thread-b', from: [{ email: 'b@example.com' }] }),
    ]);

    await adapter.start();

    expect(gate.started).toEqual(['a', 'b']);
    gate.release('a');
    gate.release('b');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('processes two emails on the same thread in order, never concurrently', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 4 });
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'first', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
      makeMockMessage({ id: 'second', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();
    expect(gate.started).toEqual(['first']);

    gate.release('first');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['first', 'second']);
    });
    gate.release('second');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('caps concurrent turns and continues the oldest waiting thread first', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 1 });
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'a1', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
      makeMockMessage({ id: 'a2', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
      makeMockMessage({ id: 'b1', threadId: 'thread-b', from: [{ email: 'b@example.com' }] }),
    ]);

    await adapter.start();
    expect(gate.started).toEqual(['a1']);

    gate.release('a1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['a1', 'b1']);
    });

    gate.release('b1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['a1', 'b1', 'a2']);
    });
    gate.release('a2');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('defaults the cap to 4', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    const gate = hangInbound(mocks.bus);
    const messages = ['t1', 't2', 't3', 't4', 't5'].map((id) =>
      makeMockMessage({ id, threadId: `thread-${id}`, from: [{ email: `${id}@example.com` }] }),
    );
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce(messages);

    await adapter.start();
    expect(gate.started).toEqual(['t1', 't2', 't3', 't4']);
    // The fifth message is queued behind the cap, and the poll still counts it.
    // The heartbeat is the fetch, not the later publish.
    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.fetched).toBe(5);
    expect(audit[0]!.payload.processed).toBe(5);

    gate.release('t1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['t1', 't2', 't3', 't4', 't5']);
    });
    for (const id of ['t2', 't3', 't4', 't5']) gate.release(id);
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('rejects a non-positive maxConcurrentTurns', () => {
    const mocks = createMocks();
    expect(() => makeAdapter(mocks, { maxConcurrentTurns: 0 })).toThrow(
      /maxConcurrentTurns must be a positive integer/,
    );
  });

  it('keeps channel.poll counts equal to fetched and logs a pre-handoff failure', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, {
      logger,
      suppressedSenderEmails: ['blocked@example.com'],
    });
    const broken = {
      ...makeMockMessage({ id: 'broken', threadId: 'thread-broken', from: [{ email: 'pat@example.com' }] }),
      attachments: undefined,
    } as unknown as NylasMessage;
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'sent', threadId: 'thread-sent', folders: ['SENT'], from: [{ email: CEO_EMAIL }] }),
      makeMockMessage({ id: 'self', threadId: 'thread-self', from: [{ email: SELF_EMAIL }] }),
      makeMockMessage({ id: 'excluded', threadId: 'thread-ex', from: [{ email: 'blocked@example.com' }] }),
      makeMockMessage({ id: 'good', threadId: 'thread-good', from: [{ email: 'ada@example.com' }] }),
      broken,
    ]);

    await adapter.start();

    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    const { payload } = audit[0]!;
    expect(payload.fetched).toBe(5);
    expect(payload.processed).toBe(1);
    expect(payload.skipped).toEqual({
      sent_folder: 1,
      recently_sent: 0,
      self: 1,
      excluded: 1,
      failed: 1,
    });
    const skippedTotal = Object.values(payload.skipped).reduce((sum, n) => sum + n, 0);
    expect(payload.processed + skippedTotal).toBe(payload.fetched);

    const failed = failureLogs(entries);
    expect(failed).toEqual([
      expect.objectContaining({ messageId: 'broken', threadId: 'thread-broken' }),
    ]);

    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('logs a detached publish failure with messageId and threadId', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, { logger });
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
      if (event.type === 'inbound.message') return Promise.reject(new Error('bus down'));
      return Promise.resolve();
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'msg-fail', threadId: 'thread-fail', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();
    await adapter.drainInFlight();

    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.processed).toBe(1);
    expect(audit[0]!.payload.skipped.failed).toBe(0);
    expect(failureLogs(entries)).toEqual([
      expect.objectContaining({ messageId: 'msg-fail', threadId: 'thread-fail' }),
    ]);

    await adapter.stop();
  });

  it('still applies reply-loop guards while a turn is in flight', async () => {
    const mocks = createMocks();
    const triggerOutbound = captureHandler('outbound.message', mocks);
    const adapter = makeAdapter(mocks);
    const gate = hangInbound(mocks.bus);
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;

    const live = makeMockMessage({
      id: 'inbound-1',
      threadId: 'thread-live',
      from: [{ email: CEO_EMAIL }],
    });
    list.mockResolvedValueOnce([live]);
    await adapter.start();
    expect(gate.started).toEqual(['inbound-1']);

    (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      messageId: 'sent-loop-id',
    });
    list.mockResolvedValueOnce([live]);
    await triggerOutbound(createOutboundMessage({
      conversationId: 'email:thread-live',
      channelId: 'email',
      content: 'Reply in flight.',
      parentEventId: 'task-1',
    }));

    list.mockResolvedValueOnce([
      makeMockMessage({
        id: 'sent-loop-id',
        threadId: 'thread-sent-id',
        from: [{ email: 'alias@example.com' }],
        folders: ['INBOX'],
      }),
      makeMockMessage({
        id: 'in-sent',
        threadId: 'thread-folder',
        from: [{ email: CEO_EMAIL }],
        folders: ['SENT'],
      }),
      makeMockMessage({
        id: 'from-self',
        threadId: 'thread-self',
        from: [{ email: 'curia+tag@example.com' }],
        folders: ['INBOX'],
      }),
      makeMockMessage({
        id: 'legit-2',
        threadId: 'thread-other',
        from: [{ email: 'ada@example.com' }],
        folders: ['INBOX'],
      }),
    ]);

    await pollNow(adapter);

    expect(gate.started).toEqual(['inbound-1', 'legit-2']);
    const secondPoll = pollEvents(mocks.bus).at(-1)!;
    expect(secondPoll.payload.fetched).toBe(4);
    expect(secondPoll.payload.processed).toBe(1);
    expect(secondPoll.payload.skipped).toMatchObject({
      sent_folder: 1,
      recently_sent: 1,
      self: 1,
      excluded: 0,
      failed: 0,
    });

    gate.release('inbound-1');
    gate.release('legit-2');
    await adapter.drainInFlight();
    await adapter.stop();
  });
});
