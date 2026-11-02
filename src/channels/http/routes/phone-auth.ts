// phone-auth.ts — the bearer-token check shared by the phone routes added after /phone/inbox
// (/phone/message, /phone/brief). One shared token (vault secret `phone_inbox_token`).
// routes/phone-inbox.ts keeps its own copy of this check so that file stays untouched.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';

// Compare SHA-256 digests so the check is constant-time and doesn't leak the token's length.
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * True when the request carries the phone token. Otherwise it has already answered the reply and returns false:
 * 404 when no token is configured (the route is invisible), 401 when the token is missing or wrong.
 */
export async function authorisePhoneRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  getToken: () => Promise<string | null>,
  logger: Logger,
  route: string,
): Promise<boolean> {
  const expected = (await getToken())?.trim();
  if (!expected) {
    await reply.status(404).send({ error: 'Not found' });
    return false;
  }
  const header = request.headers.authorization;
  const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!provided || !tokensMatch(provided, expected)) {
    // Never log the token; only whether one was sent.
    logger.warn({ ip: request.ip, reason: provided ? 'invalid_token' : 'missing_token' }, `${route}: auth failed`);
    await reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
