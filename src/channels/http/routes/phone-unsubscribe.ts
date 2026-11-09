// phone-unsubscribe.ts — POST /phone/unsubscribe, the "Unsubscribe" button on a newsletter in Command Hub.
//
//   POST /phone/unsubscribe  { account, messageId }
//
// Curia reads the email's List-Unsubscribe header. If the sender supports one-click unsubscribe (RFC 8058) Curia sends
// that request itself. Otherwise it hands the link back for the owner to open on the phone. It never sends email.
// A sender that accepted the request is remembered: if it keeps mailing, triage repeats the request up to three times and then
// moves its mail to Trash (see inbox-triage/unsubscribe-enforcer.ts).
// The answer is always 200 with a `result`:
//   unsubscribed   the sender accepted the one-click request
//   open-link      no one-click support: `url` is the sender's page; the phone opens it for the owner
//   open-mailto    the sender only offers an email address: `mailto` is the link; the phone opens it for the owner
//   failed         the one-click request was refused or timed out; `url` (if any) is the fallback to open
//   none           the email has no unsubscribe information
// Errors: 400 bad request · 404 message not found · 429 mailbox busy · 502 mailbox error · 503 mailbox not connected.
// The header comes from the sender, so it is untrusted: only an https link on a public host is ever requested, and the
// full link (it often holds a personal token) is never logged — only the host name.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { NylasUnsubscribeReader } from '../../../phone-inbox/nylas-unsubscribe.js';
import { MailboxRateLimitedError, PHONE_INBOX_ACCOUNT_IDS, type PhoneInboxAccountId } from '../../../phone-inbox/phone-inbox-service.js';
import { oneClickTarget, parseListUnsubscribe, postOneClick, type OneClickResult } from '../../../phone-inbox/unsubscribe.js';
import { authorisePhoneRequest } from './phone-auth.js';

export interface PhoneUnsubscribeRouteOptions {
  logger: Logger;
  getToken: () => Promise<string | null>;
  /** The reader for one mailbox, or null when it is not connected. */
  getReader: (account: PhoneInboxAccountId) => Promise<Pick<NylasUnsubscribeReader, 'read'> | null>;
  /** Told when a sender was unsubscribed, so triage can repeat the request if they keep mailing. Failures are logged only. */
  onUnsubscribed?: (account: PhoneInboxAccountId, senderAddress: string) => Promise<void>;
  /** Sends the one-click request. Replaceable in tests. */
  oneClick?: (url: URL) => Promise<OneClickResult>;
}

const MAX_ID_LENGTH = 256;

export async function phoneUnsubscribeRoutes(app: FastifyInstance, options: PhoneUnsubscribeRouteOptions): Promise<void> {
  const { logger, getToken, getReader, onUnsubscribed, oneClick = (url) => postOneClick(url) } = options;

  app.post('/phone/unsubscribe', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-unsubscribe'))) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>; // shape checked field by field below
    const account = PHONE_INBOX_ACCOUNT_IDS.find((id) => id === body.account);
    const messageId = body.messageId;
    if (!account || typeof messageId !== 'string' || messageId.length === 0 || messageId.length > MAX_ID_LENGTH) {
      return reply.status(400).send({ error: 'account and messageId are required' });
    }

    try {
      const reader = await getReader(account);
      if (!reader) return reply.status(503).send({ error: 'Mailbox not connected' });
      const headers = await reader.read(messageId);
      if (!headers) return reply.status(404).send({ error: 'Not found' });

      const unsub = parseListUnsubscribe(headers.listUnsubscribe, headers.listUnsubscribePost);
      const link = unsub.links[0] ?? null;
      const mailto = unsub.mailtos[0] ?? null;
      const send = (payload: Record<string, unknown>) => reply.header('Cache-Control', 'no-store').send(payload);

      if (unsub.oneClick && link) {
        const target = oneClickTarget(link);
        if (target) {
          const outcome = await oneClick(target);
          logger.info({ account, host: target.hostname, ok: outcome.ok, status: outcome.status }, 'phone-unsubscribe: one-click request');
          if (outcome.ok && onUnsubscribed && headers.fromAddress) {
            try {
              await onUnsubscribed(account, headers.fromAddress);
            } catch (err) {
              // The unsubscribe itself worked; only the follow-up memory is lost.
              logger.warn({ err, account }, 'phone-unsubscribe: could not remember the unsubscribe');
            }
          }
          return send(outcome.ok ? { result: 'unsubscribed' } : { result: 'failed', url: link });
        }
        logger.warn({ account }, 'phone-unsubscribe: one-click link refused (not an https link on a public host)');
        return send({ result: 'failed', url: link });
      }
      if (link) return send({ result: 'open-link', url: link });
      if (mailto) return send({ result: 'open-mailto', mailto });
      return send({ result: 'none' });
    } catch (err) {
      if (err instanceof MailboxRateLimitedError) return reply.status(429).send({ error: 'Mailbox busy' });
      logger.warn({ err, account }, 'phone-unsubscribe: could not read the email');
      return reply.status(502).send({ error: 'Could not read the email' });
    }
  });
}
