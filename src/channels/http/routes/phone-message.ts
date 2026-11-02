// phone-message.ts — GET /phone/message, the plain text of one email for the Command Hub email page.
//
// Same bearer token as /phone/inbox (secret `phone_inbox_token`, one shared token by the owner's decision, so a
// leaked token now also exposes email text). Outside /api, so the main API_TOKEN does not work here. No token in the
// vault → 404, so the route is invisible until the phone is switched on. The body is never logged, cached or kept:
// it is read from Nylas, returned with `Cache-Control: no-store`, and dropped.
// Contract: contracts/phone-inbox.openapi.yaml in the MVOS repo.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { NylasMailboxError } from '../../../phone-inbox/nylas-mailbox.js';
import type { NylasMessageReader } from '../../../phone-inbox/nylas-message.js';
import { MailboxRateLimitedError, PHONE_INBOX_ACCOUNT_IDS, type PhoneInboxAccountId } from '../../../phone-inbox/phone-inbox-service.js';
import { authorisePhoneRequest } from './phone-auth.js';

export interface PhoneMessageRouteOptions {
  logger: Logger;
  /** The phone's token, read from the vault on each request; null when not configured. */
  getToken: () => Promise<string | null>;
  /** The reader for one mailbox, or null when that mailbox is not connected. */
  getReader: (account: PhoneInboxAccountId) => Promise<NylasMessageReader | null>;
}

const MAX_ID_LENGTH = 256;

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export async function phoneMessageRoutes(app: FastifyInstance, options: PhoneMessageRouteOptions): Promise<void> {
  const { logger, getToken, getReader } = options;

  // One request per email the owner opens; 30/min leaves room for browsing and still blocks guessing.
  app.get<{ Querystring: { account?: string; threadId?: string; messageId?: string } }>(
    '/phone/message',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-message'))) return reply;

      const { account, threadId, messageId } = request.query;
      const accountId = PHONE_INBOX_ACCOUNT_IDS.find((id) => id === account);
      if (!accountId || !validId(threadId) || (messageId !== undefined && !validId(messageId))) {
        return reply.status(400).send({ error: 'Bad request' });
      }

      try {
        const reader = await getReader(accountId);
        // A mailbox that is not connected has no email to show: the phone shows the header only.
        const message = reader ? await reader.read(threadId, messageId) : null;
        if (!message) return reply.status(404).send({ error: 'Not found' });
        return reply.header('Cache-Control', 'no-store').send(message);
      } catch (err) {
        if (err instanceof MailboxRateLimitedError) {
          if (err.retryAfterSeconds) reply.header('Retry-After', String(err.retryAfterSeconds));
          return reply.status(503).send({ error: 'Mailbox busy' });
        }
        if (err instanceof NylasMailboxError) {
          // Status only; the error carries no email content.
          logger.warn({ account: accountId, status: err.status }, 'phone-message: mailbox read failed');
          return reply.status(502).send({ error: 'Mailbox unavailable' });
        }
        logger.error({ err }, 'phone-message: unexpected failure');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );
}
