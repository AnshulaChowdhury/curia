import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { phoneBooksRoutes, type PhoneBooksRouteOptions } from '../../../../../src/channels/http/routes/phone-books.js';
import type { ReviewCard } from '../../../../../src/books/batch-store.js';
import { createSilentLogger } from '../../../../../src/logger.js';

const CARD: ReviewCard = {
  id: 'r1', batchId: 'abcdef12', date: '2026-11-02', description: 'MYSTERY VENDOR LTD', amount: '-12.00', account: 'RBC chequing',
  category: null, categorySource: 'Needs your input', taxCode: null, location: null, reasons: ['Needs a category'],
};
const TOKEN = 'phone-secret';

describe('GET /phone/books/review', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(token: string | null, batches: PhoneBooksRouteOptions['batches'] = { reviewCards: async () => [CARD], reviewCount: async () => 1 }) {
    app = Fastify();
    await app.register(phoneBooksRoutes, { logger: createSilentLogger(), getToken: async () => token, batches });
  }
  const get = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/phone/books/review', headers });

  it('is invisible (404) until the phone token exists, and 401 without or with the wrong token', async () => {
    await build(null);
    expect((await get({ authorization: `Bearer ${TOKEN}` })).statusCode).toBe(404);
    await app.close();
    await build(TOKEN);
    expect((await get()).statusCode).toBe(401);
    expect((await get({ authorization: 'Bearer wrong' })).statusCode).toBe(401);
  });

  it('returns the cards and the count, uncached', async () => {
    await build(TOKEN);
    const res = await get({ authorization: `Bearer ${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ count: 1, cards: [CARD] });
    expect(res.json().generatedAt).toBeTruthy();
  });

  it('asks for at most 50 cards and reports a storage failure as 500 without detail', async () => {
    let asked = 0;
    await build(TOKEN, { reviewCards: async (n: number) => { asked = n; return []; }, reviewCount: async () => 0 });
    expect((await get({ authorization: `Bearer ${TOKEN}` })).json()).toMatchObject({ count: 0, cards: [] });
    expect(asked).toBe(50);
    await app.close();
    await build(TOKEN, { reviewCards: async () => { throw new Error('secret db detail'); }, reviewCount: async () => 0 });
    const res = await get({ authorization: `Bearer ${TOKEN}` });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret db detail');
  });
});
