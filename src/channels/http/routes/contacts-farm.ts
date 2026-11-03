// contacts-farm.ts — start and watch the background mailbox scans behind the Contacts import.
//
//   GET  /api/contacts/import/farm                  progress of each mailbox (counts only)
//   POST /api/contacts/import/farm/:accountId       start a scan; { resume: true } continues a stopped one
//
// Session auth, low rate limits. Nothing returned or logged holds an address, a name or message content.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { FarmService } from './contacts-farm-types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface ContactsFarmRouteOptions {
  logger: Logger;
  service: FarmService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function contactsFarmRoutes(app: FastifyInstance, options: ContactsFarmRouteOptions): Promise<void> {
  const { logger, service, webAppBootstrapSecret, sessions } = options;

  app.get('/api/contacts/import/farm', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send({ mailboxes: await service.status() });
  });

  app.post<{ Params: { accountId: string }; Body: { resume?: unknown } | undefined }>(
    '/api/contacts/import/farm/:accountId',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
      const resume = request.body?.resume === true;
      try {
        const r = await service.start(request.params.accountId, resume);
        if (!r.ok) {
          const status = r.reason === 'unknown_account' ? 404 : r.reason === 'already_running' ? 409 : 400;
          return reply.status(status).send({ error: r.message, code: r.reason });
        }
        return reply.status(202).send({ started: true });
      } catch (err) {
        logger.error({ errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-farm: could not start a scan');
        return reply.status(500).send({ error: 'Could not start the scan. See the server log.' });
      }
    },
  );
}
