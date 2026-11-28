// History carries text from emails, messages and tool results. It must leave the server as data, never as a page.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { historyRoutes, type HistoryRouteOptions } from '../../../../src/channels/http/routes/history.js';
import { registerSecurityHeaders } from '../../../../src/channels/http/security-headers.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';

const SECRET = 'made-up-console-secret';
const MARKUP = '<script>alert(1)</script>';
const ID = '00000000-0000-4000-8000-000000000001';

const history: HistoryRouteOptions['history'] = {
  conversations: async () => ({
    hasMore: false,
    conversations: [{ id: MARKUP, title: MARKUP, startedAt: '', lastAt: '', events: 1, errors: 0, agents: [MARKUP], channels: [], costUsd: 0 }],
  }),
  facets: async () => ({ agents: [MARKUP], channels: [MARKUP] }),
  // Echoes what was asked for, the worst case for text a caller controls.
  steps: async (query) => ({
    hasEarlier: false,
    steps: [{ id: ID, seq: '1', at: '', type: 't', agent: null, depth: 0, label: String(query.conversationId), preview: MARKUP, failed: false }],
  }),
  detail: async () => ({ id: ID, at: '', type: 't', conversationId: MARKUP, payload: { content: MARKUP }, result: null, archive: null, notes: [] }),
};

describe('history responses', () => {
  it.each([
    '/api/history',
    `/api/history/steps?conversation=${encodeURIComponent(MARKUP)}`,
    `/api/history/events/${ID}`,
  ])('%s is JSON that a browser will not read as a page', async (url) => {
    const app = Fastify();
    await app.register(cookie);
    registerSecurityHeaders(app);
    await app.register(historyRoutes, { history, webAppBootstrapSecret: SECRET, sessions: new Map() as unknown as SessionStore, logger: createSilentLogger() });
    const response = await app.inject({ method: 'GET', url, headers: { 'x-web-bootstrap-secret': SECRET } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toContain(MARKUP);
    await app.close();
  });
});
