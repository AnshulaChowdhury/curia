import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { booksRunRoutes } from '../../../src/channels/http/routes/books-run.js';
import type { BooksRunner } from '../../../src/books/books-runner.js';
import type { Logger } from '../../../src/logger.js';
import type { SessionStore } from '../../../src/channels/http/session-auth.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const SECRET = 'a-long-bootstrap-secret-for-tests-0123456789';
const auth = { 'x-web-bootstrap-secret': SECRET };

async function app(runner: BooksRunner | null) {
  const a = Fastify();
  await a.register(booksRunRoutes, { logger, runner, webAppBootstrapSecret: SECRET, sessions: { verify: () => null } as unknown as SessionStore });
  return a;
}

describe('/api/books/run', () => {
  it('needs the owner', async () => {
    const a = await app(null);
    expect((await a.inject({ method: 'POST', url: '/api/books/run' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/books/run' })).statusCode).toBe(401);
  });

  it('says whether the service is set up, and 503s a run when it is not', async () => {
    const a = await app(null);
    expect((await a.inject({ method: 'GET', url: '/api/books/run', headers: auth })).json()).toEqual({ available: false });
    expect((await a.inject({ method: 'POST', url: '/api/books/run', headers: auth })).statusCode).toBe(503);
  });

  it('runs now and returns what happened', async () => {
    const runOnce = vi.fn(async () => ({ outcome: 'nothing_waiting' as const }));
    const a = await app({ runOnce } as unknown as BooksRunner);
    const res = await a.inject({ method: 'POST', url: '/api/books/run', headers: auth });
    expect(res.json()).toEqual({ outcome: 'nothing_waiting' });
    expect(runOnce).toHaveBeenCalledWith('manual');
  });
});
