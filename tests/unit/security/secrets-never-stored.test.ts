// The places a password or key could be kept or shown, each checked with the same made-up one (ADR-070).
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import { encodeResumeToken } from '../../../src/agents/resume-token.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, createToolInvoke } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { sanitizeObjectOutput, sanitizeOutput } from '../../../src/skills/sanitize.js';
import { redactArchiveContent } from '../../../src/audit/llm-call-archive.js';
import { toChatHistoryMessage } from '../../../src/channels/http/chat-history-page.js';
import { chatRoutes } from '../../../src/channels/http/routes/chat.js';
import type { EventRouter } from '../../../src/channels/http/event-router.js';
import type { SessionStore } from '../../../src/channels/http/session-auth.js';
import { forgetKnownSecrets, redactSecrets, SECRET_REMOVED } from '../../../src/security/redact-secrets.js';

const PASSWORD = 'Made-Up-Pass-9';
const SAID = `my password is ${PASSWORD}`;
const KEPT = `my password is ${SECRET_REMOVED}`;
const message = (content: string) => createInboundMessage({ conversationId: 'c1', channelId: 'web', senderId: 'owner', content });

afterEach(() => forgetKnownSecrets());

describe('the bus', () => {
  it.each(['publish', 'publishDetached', 'stagePublish'] as const)('%s records and delivers only what is left', async (method) => {
    const recorded: unknown[] = [];
    const delivered: unknown[] = [];
    const bus = new EventBus(createLogger('error'), (event) => { recorded.push(event.payload); });
    bus.subscribe('inbound.message', 'dispatch', (event) => { delivered.push(event.payload); });
    const event = message(SAID);
    const staged = await bus[method]('channel', event);
    if (staged) await staged.deliver();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(recorded).toEqual([expect.objectContaining({ content: KEPT })]);
    expect(delivered).toEqual([expect.objectContaining({ content: KEPT })]);
    expect(event.payload.content).toBe(SAID);
  });

  it('removes secrets from what a tool was given, leaving the tool’s own input alone', async () => {
    const recorded: string[] = [];
    const bus = new EventBus(createLogger('error'), (event) => { recorded.push(JSON.stringify(event.payload)); });
    const input = { url: 'https://example.test', password: PASSWORD };
    await bus.publish('agent', createToolInvoke({ agentId: 'a', conversationId: 'c', toolName: 't', input, taskEventId: 'task', parentEventId: 'task' }));
    expect(recorded[0]).not.toContain(PASSWORD);
    expect(input.password).toBe(PASSWORD);
  });

  it('cleans an older row when it is delivered again', async () => {
    const delivered: unknown[] = [];
    const bus = new EventBus(createLogger('error'));
    bus.subscribe('inbound.message', 'dispatch', (event) => { delivered.push(event.payload); });
    await bus.deliverPersisted(message(SAID));
    expect(delivered).toEqual([expect.objectContaining({ content: KEPT })]);
  });
});

describe('handles agents pass back', () => {
  it('leaves a paused specialist’s resume handle intact', () => {
    const resume_token = encodeResumeToken({ agent: 'budget', originalTask: 'Plan the month. '.repeat(40), context: 'Which month?' });
    const content = JSON.stringify({ _curia_protocol: 'clarification_request', question: 'Which month?', resume_token });
    expect(redactSecrets(content)).toBe(content);
  });
});

describe('conversation memory', () => {
  it('stores and returns only what is left', async () => {
    const memory = WorkingMemory.createInMemory();
    await memory.addTurn('c1', 'coordinator', { role: 'user', content: SAID });
    expect(await memory.getHistory('c1', 'coordinator', { raw: true })).toEqual([{ role: 'user', content: KEPT }]);
  });
});

describe('tool results, AI archive and chat history', () => {
  it('removes secrets from tool results, including a field that only its name gives away', () => {
    expect(sanitizeOutput(SAID)).toBe(KEPT);
    expect(JSON.stringify(sanitizeObjectOutput({ login: { password: PASSWORD, note: SAID } }))).not.toContain(PASSWORD);
  });

  it('removes secrets from the AI call archive', () => {
    expect(JSON.stringify(redactArchiveContent({ messages: [{ content: SAID }] }))).not.toContain(PASSWORD);
  });

  it('removes secrets from older chat messages before showing them', () => {
    const shown = toChatHistoryMessage(
      { id: '1', role: 'assistant', content: SAID, created_at: new Date(0), created_at_iso: '1970-01-01T00:00:00.000000Z' },
      (text) => `<p>${text}</p>`,
    );
    expect(shown).toMatchObject({ content: KEPT, html: `<p>${KEPT}</p>` });
  });
});

describe('sending a chat message', () => {
  const send = async (text: string) => {
    const publish = vi.fn();
    const app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool: {} as Pool, logger: createLogger('error'), webAppBootstrapSecret: 'made-up-console-secret',
      bus: { publish } as unknown as EventBus, eventRouter: {} as EventRouter, sessions: new Map() as unknown as SessionStore,
    });
    const response = await app.inject({
      method: 'POST', url: '/api/chat/messages', headers: { 'x-web-bootstrap-secret': 'made-up-console-secret' },
      payload: { message: text, conversationId: 'c1' },
    });
    await app.close();
    return { body: response.json(), published: publish.mock.calls[0]![1].payload.content as string };
  };

  it('publishes what is left and tells the screen', async () => {
    expect(await send(SAID)).toEqual({ body: { conversationId: 'c1', keptMessage: KEPT }, published: KEPT });
  });

  it('says nothing extra for an ordinary message', async () => {
    expect(await send('hello')).toEqual({ body: { conversationId: 'c1' }, published: 'hello' });
  });
});
