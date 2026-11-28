// Settings → History against real Postgres: events published on the bus, audited, then read back (ADR-072).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import pg from 'pg';
import { AuditLogger } from '../../src/audit/logger.js';
import { HistoryRepo } from '../../src/audit/history-repo.js';
import { EventBus } from '../../src/bus/bus.js';
import {
  createAgentResponse, createAgentTask, createInboundMessage, createLlmCall, createToolInvoke, createToolRecorded,
  createToolResult, type BusEvent,
} from '../../src/bus/events.js';
import { createSilentLogger } from '../../src/logger.js';
import { historyRoutes } from '../../src/channels/http/routes/history.js';
import { bypassesBearerAuth } from '../../src/channels/http/auth.js';
import type { SessionStore } from '../../src/channels/http/session-auth.js';

const { DATABASE_URL } = process.env;
const SECRET = 'made-up-console-secret';

describe.skipIf(!DATABASE_URL)('history', () => {
  const run = randomUUID();
  const chat = `history-chat-${run}`;
  const specialist = `delegate-history-${run}`;
  // A window of its own: audit rows cannot be deleted, so each run uses a different far-future hour.
  const start = Date.UTC(2100, 0, 1) + randomInt(0, 5_000_000) * 3_600_000;
  const window = { from: new Date(start), to: new Date(start + 3_600_000) };
  let pool: pg.Pool;
  let repo: HistoryRepo;
  let n = 0;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    repo = new HistoryRepo(pool);
    const audit = new AuditLogger(pool, createSilentLogger());
    const bus = new EventBus(createSilentLogger(), (event) => audit.log(event));
    const send = async (name: string, layer: Parameters<EventBus['publish']>[0], event: BusEvent) => {
      const timed = { ...event, timestamp: new Date(start + ++n * 1000) } as BusEvent;
      ids[name] = timed.id;
      await bus.publish(layer, timed);
    };

    await send('inbound', 'channel', createInboundMessage({ conversationId: chat, channelId: 'web', senderId: 'owner', content: 'Plan the month, my password is Made-Up-Pass-9' }));
    await send('task', 'dispatch', createAgentTask({ agentId: 'coordinator', conversationId: chat, channelId: 'web', senderId: 'owner', content: 'Plan the month', parentEventId: ids.inbound! }));
    await send('call', 'agent', createToolInvoke({ agentId: 'coordinator', conversationId: chat, toolName: 'delegate', input: { agent: 'budget' }, taskEventId: ids.task!, parentEventId: ids.task! }));
    await send('subtask', 'dispatch', createAgentTask({ agentId: 'budget', conversationId: specialist, channelId: 'internal', senderId: 'coordinator', content: 'Plan it', metadata: { delegationOrigin: { conversationId: chat } }, parentEventId: ids.call! }));
    await send('llm', 'agent', createLlmCall({
      agentId: 'budget', conversationId: specialist, requestedModel: 'm', actualModel: 'm', provider: 'p', inputTokens: 10, outputTokens: 5,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0.25, latencyMs: 1, providerRequestId: 'r', promptHash: 'h', responseHash: 'h',
      parentEventId: ids.subtask!, archive: { prompt: { messages: [{ role: 'user', content: 'Plan it' }] }, response: { type: 'text', content: 'Planned' } },
    }));
    await send('sub-call', 'agent', createToolInvoke({ agentId: 'budget', conversationId: specialist, toolName: 'budget-plan', input: { months: 3 }, taskEventId: ids.subtask!, parentEventId: ids.subtask! }));
    await send('sub-result', 'agent', createToolResult({ agentId: 'budget', conversationId: specialist, toolName: 'budget-plan', result: { success: false, error: 'no plan' }, durationMs: 3, parentEventId: ids['sub-call']! }));
    await send('recorded', 'execution', createToolRecorded({ agentId: 'system:memory-extraction', conversationId: chat, toolName: 'extract-facts', input: { text: 'Plan the month' }, result: { success: true, data: { stored: 1 } }, durationMs: 4 }));
    await send('reply', 'agent', createAgentResponse({ agentId: 'coordinator', conversationId: chat, content: 'Done', parentEventId: ids.task! }));
  });

  afterAll(async () => { await pool.end(); });

  it('lists a conversation once, with the specialists it delegated to', async () => {
    const { conversations } = await repo.conversations(window);
    expect(conversations).toEqual([{
      id: chat, title: 'Plan the month, my password is [secret removed]',
      startedAt: new Date(start + 1000).toISOString(), lastAt: new Date(start + 9000).toISOString(),
      events: 9, errors: 1, agents: expect.arrayContaining(['coordinator', 'budget', 'system:memory-extraction']), channels: ['web'], costUsd: 0.25,
    }]);
  });

  it('filters by agent, channel and errors', async () => {
    const count = async (extra: object) => (await repo.conversations({ ...window, ...extra })).conversations.length;
    expect(await count({ agent: 'budget' })).toBe(1);
    expect(await count({ agent: 'nobody' })).toBe(0);
    expect(await count({ channel: 'email' })).toBe(0);
    expect(await count({ errorsOnly: true })).toBe(1);
    expect(await repo.facets(window)).toEqual({ agents: expect.arrayContaining(['budget']), channels: ['web'] });
  });

  it('shows every step in order, a call and its result as one', async () => {
    const { steps, hasEarlier } = await repo.steps({ ...window, conversationId: chat });
    expect(hasEarlier).toBe(false);
    expect(steps.map(s => [s.id, s.depth, s.failed])).toEqual([
      [ids.inbound, 0, false], [ids.task, 0, false], [ids.call, 0, false], [ids.subtask, 1, false], [ids.llm, 1, false],
      [ids['sub-call'], 1, true], [ids.recorded, 0, false], [ids.reply, 0, false],
    ]);
  });

  it('pages back from the newest steps', async () => {
    const newest = await repo.steps({ ...window, conversationId: chat, limit: 2 });
    expect([newest.hasEarlier, newest.steps.map(s => s.id)]).toEqual([true, [ids.recorded, ids.reply]]);
    const earlier = await repo.steps({ ...window, conversationId: chat, limit: 2, before: newest.steps[0]!.seq });
    expect(earlier.steps.map(s => s.id)).toEqual([ids.llm, ids['sub-call']]);
  });

  it('gives a call its result and an AI call its prompt and reply', async () => {
    expect(await repo.detail(ids['sub-call']!)).toMatchObject({ payload: { input: { months: 3 } }, result: { result: { error: 'no plan' } }, notes: [] });
    expect(await repo.detail(ids.llm!)).toMatchObject({ archive: { response: { content: 'Planned' } }, notes: [expect.stringContaining('masked')] });
    expect(await repo.detail(ids.call!)).toMatchObject({ result: null, notes: ['No result was recorded for this call.'] });
    expect(JSON.stringify(await repo.detail(ids.inbound!))).not.toContain('Made-Up-Pass-9');
  });

  it('answers only the console sign-in', async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(historyRoutes, { history: repo, webAppBootstrapSecret: SECRET, sessions: new Map() as unknown as SessionStore, logger: createSilentLogger() });
    const urls = ['/api/history', '/api/history/steps', `/api/history/events/${ids.llm}`];
    for (const url of urls) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer made-up-phone-token' } })).statusCode).toBe(401);
    }
    const headers = { 'x-web-bootstrap-secret': SECRET };
    const query = `from=${window.from.toISOString()}&to=${window.to.toISOString()}`;
    expect((await app.inject({ method: 'GET', url: `/api/history?${query}`, headers })).json().conversations).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/history/steps?conversation=${chat}&${query}`, headers })).json().steps).toHaveLength(8);
    expect((await app.inject({ method: 'GET', url: '/api/history/events/not-an-id', headers })).statusCode).toBe(400);
    expect(bypassesBearerAuth('/api/history/steps')).toBe(true);
    await app.close();
  });
});
