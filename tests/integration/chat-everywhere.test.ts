// The console chat follows the owner between devices and is kept (ADR-071), against real Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import pg from 'pg';
import { chatRoutes } from '../../src/channels/http/routes/chat.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createLogger } from '../../src/logger.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { EventRouter } from '../../src/channels/http/event-router.js';
import type { SessionStore } from '../../src/channels/http/session-auth.js';

const { DATABASE_URL } = process.env;
const SECRET = 'made-up-console-secret';

describe.skipIf(!DATABASE_URL)('console chat across devices', () => {
  const run = randomUUID();
  const [first, second, mail, specialist] = ['first', 'second', 'mail', 'specialist'].map(n => `chat-everywhere-${n}-${run}`) as [string, string, string, string];
  let pool: pg.Pool;
  let memory: WorkingMemory;
  let app: ReturnType<typeof Fastify>;

  const add = (conversationId: string, role: 'user' | 'assistant' | 'system', content: string, channelId: string | undefined, at: string, extra: { synthetic?: boolean; expired?: boolean; archived?: boolean } = {}) =>
    pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content, channel_id, created_at, synthetic, archived, expires_at)
       VALUES ($1, 'coordinator', $2, $3, $4, $5, $6, $7, $8)`,
      [conversationId, role, content, channelId ?? null, at, extra.synthetic ?? false, extra.archived ?? false, extra.expired ? '2000-01-01' : null],
    );
  const get = (url: string, headers: Record<string, string> = { 'x-web-bootstrap-secret': SECRET }) => app.inject({ method: 'GET', url, headers });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    memory = WorkingMemory.createWithPostgres(pool, createLogger('error'));
    app = Fastify();
    await app.register(cookie);
    await app.register(chatRoutes, {
      pool, logger: createLogger('error'), webAppBootstrapSecret: SECRET, sessions: new Map() as unknown as SessionStore,
      bus: {} as EventBus, eventRouter: {} as EventRouter,
    });
    // Far-future times, so these rows are the newest whatever else the database holds.
    await add(first, 'user', 'older chat', 'web', '2090-01-01T00:00:00Z', { expired: true });
    await add(second, 'user', 'said long ago', 'web', '2090-02-01T00:00:00Z', { expired: true, archived: true });
    await add(second, 'system', '[Conversation summary]', undefined, '2090-02-01T00:00:01Z', { expired: true });
    await add(second, 'user', 'said recently', 'web', '2090-02-02T00:00:00Z', { expired: true });
    await add(first, 'user', 'a note Curia wrote itself', 'web', '2090-03-01T00:00:00Z', { synthetic: true });
    await add(mail, 'user', 'an email', 'email', '2090-04-01T00:00:00Z', { expired: true });
    await add(specialist, 'user', 'a brief', 'internal', '2090-05-01T00:00:00Z', { expired: true });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM working_memory WHERE conversation_id = ANY($1)', [[first, second, mail, specialist]]);
    await app.close();
    await pool.end();
  });

  it('names the web chat last written in by a person', async () => {
    expect((await get('/api/chat/current')).json()).toEqual({ conversationId: second });
  });

  it('needs the console sign-in', async () => {
    expect((await get('/api/chat/current', {})).statusCode).toBe(401);
  });

  it('shows summarised messages but not the summary', async () => {
    const body = (await get(`/api/chat/history?conversationId=${encodeURIComponent(second)}`)).json() as { messages: { content: string }[] };
    expect(body.messages.map(m => m.content)).toEqual(['said long ago', 'said recently']);
  });

  it('never expires a web chat, and still expires other conversations', async () => {
    await memory.purgeExpired();
    const left = await pool.query<{ conversation_id: string; n: string }>(
      'SELECT conversation_id, count(*) AS n FROM working_memory WHERE conversation_id = ANY($1) GROUP BY conversation_id',
      [[first, second, mail, specialist]],
    );
    expect(Object.fromEntries(left.rows.map(r => [r.conversation_id, Number(r.n)]))).toEqual({ [first]: 2, [second]: 3 });
  });
});
