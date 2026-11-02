// phone-inbox-assistant-name.test.ts — the optional `assistantName` field on GET /phone/inbox.

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { cleanAssistantName, phoneInboxRoutes } from '../../../../../src/channels/http/routes/phone-inbox.js';
import type { PhoneInbox, PhoneInboxService } from '../../../../../src/phone-inbox/phone-inbox-service.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const INBOX: PhoneInbox = {
  updatedAt: '2026-11-02T12:00:00.000Z',
  accounts: [{ id: 'moonray', address: 'ac@example.com', syncing: true, needsYou: 0, unread: 0, items: [] }],
};
const AUTH = { authorization: 'Bearer secret' };

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function get(getAssistantName?: () => string | null) {
  app = Fastify();
  await app.register(phoneInboxRoutes, {
    logger: createSilentLogger(),
    getToken: async () => 'secret',
    getService: async () => ({ build: async () => INBOX }) as unknown as PhoneInboxService,
    ...(getAssistantName ? { getAssistantName } : {}),
  });
  return (await app.inject({ method: 'GET', url: '/phone/inbox', headers: AUTH })).json() as Record<string, unknown>;
}

describe('GET /phone/inbox assistantName', () => {
  it('sends the full name next to the existing fields, which are unchanged', async () => {
    const body = await get(() => 'Jordan Rivera');
    expect(body).toEqual({ ...INBOX, assistantName: 'Jordan Rivera' });
  });

  it('sends null when the name is unknown', async () => {
    expect((await get(() => null)).assistantName).toBeNull();
    expect((await get(() => '   ')).assistantName).toBeNull();
  });

  it('leaves the field out when the route is not given a name source (older wiring)', async () => {
    const body = await get();
    expect('assistantName' in body).toBe(false);
    expect(body).toEqual(INBOX);
  });

  it('still requires the token', async () => {
    app = Fastify();
    await app.register(phoneInboxRoutes, {
      logger: createSilentLogger(),
      getToken: async () => 'secret',
      getService: async () => ({ build: async () => INBOX }) as unknown as PhoneInboxService,
      getAssistantName: () => 'Jordan Rivera',
    });
    const res = await app.inject({ method: 'GET', url: '/phone/inbox' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('Jordan');
  });
});

describe('cleanAssistantName', () => {
  it('flattens to one line, strips control characters and caps at 80 characters', () => {
    expect(cleanAssistantName('  Jordan\n  Rivera\u0000 ')).toBe('Jordan Rivera');
    expect(cleanAssistantName('x'.repeat(200))).toHaveLength(80);
    expect(cleanAssistantName(undefined)).toBeNull();
    expect(cleanAssistantName('')).toBeNull();
  });
});
