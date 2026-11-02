// phone-books.ts — GET /phone/books/review, the cards for the "Transactions to review" page of the Command Hub phone launcher.
//
// Same bearer token as /phone/inbox and /phone/message (secret `phone_inbox_token`, one shared token by the owner's
// decision). Outside /api, so the main API_TOKEN does not work here. No token in the vault → 404. Read-only: the phone can
// look at the transactions but cannot approve or change anything; that stays on the Books page.
//
// Each card carries a bank line (date, bank text, amount) because the owner asked to see the transactions on the phone;
// the text is untrusted (it comes from a bank file), is capped and stripped of control characters, and is plain text.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { ReviewCard } from '../../../books/batch-store.js';

export interface PhoneBooksRouteOptions {
  logger: Logger;
  /** The phone's token, read from the vault on each request; null when not configured. */
  getToken: () => Promise<string | null>;
  batches: { reviewCards(limit: number): Promise<ReviewCard[]>; reviewCount(): Promise<number> };
}

const MAX_CARDS = 50;

function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
}

export async function phoneBooksRoutes(app: FastifyInstance, options: PhoneBooksRouteOptions): Promise<void> {
  const { logger, getToken, batches } = options;

  app.get('/phone/books/review', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const expected = (await getToken())?.trim();
    if (!expected) return reply.status(404).send({ error: 'Not found' });

    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!provided || !tokensMatch(provided, expected)) {
      logger.warn({ ip: request.ip, reason: provided ? 'invalid_token' : 'missing_token' }, 'phone-books: auth failed');
      return reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
    }

    try {
      const [cards, count] = await Promise.all([batches.reviewCards(MAX_CARDS), batches.reviewCount()]);
      // Bank lines: keep them out of any shared cache.
      return reply.header('Cache-Control', 'no-store').send({ generatedAt: new Date().toISOString(), count, cards });
    } catch (err) {
      logger.error({ err }, 'phone-books: unexpected failure');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
