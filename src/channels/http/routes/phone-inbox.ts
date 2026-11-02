// phone-inbox.ts — GET /phone/inbox, the read-only email summary for the Command Hub phone launcher.
//
// Deliberately outside /api: it has its own token (secret `phone_inbox_token`) that works for this route and
// GET /phone/message only, and the main API_TOKEN does not work here. The global /api bearer hook never sees it.
// Not configured (no token in the vault) → 404, so the route is invisible until it's switched on.
// Contract: contracts/phone-inbox.openapi.yaml in the MVOS repo.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { PhoneInboxUnavailableError, type PhoneInboxService } from '../../../phone-inbox/phone-inbox-service.js';

export interface PhoneInboxRouteOptions {
  logger: Logger;
  /** The phone's token, read from the vault on each request; null when not configured. */
  getToken: () => Promise<string | null>;
  /** Builds the service from the vault's current Nylas secrets. */
  getService: () => Promise<PhoneInboxService>;
}

// Compare SHA-256 digests so the check is constant-time and doesn't leak the token's length.
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function phoneInboxRoutes(app: FastifyInstance, options: PhoneInboxRouteOptions): Promise<void> {
  const { logger, getToken, getService } = options;

  // Home refreshes every 15 minutes; 30/min leaves room for retries and still blocks guessing.
  app.get('/phone/inbox', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const expected = (await getToken())?.trim();
    if (!expected) return reply.status(404).send({ error: 'Not found' });

    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!provided || !tokensMatch(provided, expected)) {
      // Never log the token; only whether one was sent.
      logger.warn({ ip: request.ip, reason: provided ? 'invalid_token' : 'missing_token' }, 'phone-inbox: auth failed');
      return reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
    }

    try {
      const inbox = await (await getService()).build();
      // Email metadata: keep it out of any shared cache.
      return reply.header('Cache-Control', 'no-store').send(inbox);
    } catch (err) {
      if (err instanceof PhoneInboxUnavailableError) {
        return reply.status(502).send({ error: 'Mailbox unavailable' });
      }
      logger.error({ err }, 'phone-inbox: unexpected failure');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
