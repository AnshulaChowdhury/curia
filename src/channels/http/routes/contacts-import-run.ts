// contacts-import-run.ts — Preview and Apply for the Contacts page "Sources" drawer.
//
//   POST /api/contacts/import/preview   read the ready sources, merge, dry run; counts and a small masked sample
//   POST /api/contacts/import/apply     { runId } — apply exactly that preview, once
//
// Session auth like the other console routes, low rate limits. Preview writes no contacts. Apply writes only what the
// preview planned, as tier `unknown`, with unverified identities (see import-service.ts). No names, numbers or bridge
// addresses are logged; the preview's sample is masked.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { ImportError } from '../../../contacts-import/import-service.js';
import { PullError, type ContactsPullService } from '../../../contacts-import/pull-service.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface ContactsImportRunRouteOptions {
  logger: Logger;
  /** Built per request so it sees the current vault settings. */
  getService: () => Promise<ContactsPullService>;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function contactsImportRunRoutes(app: FastifyInstance, options: ContactsImportRunRouteOptions): Promise<void> {
  const { logger, getService, webAppBootstrapSecret, sessions } = options;

  app.post('/api/contacts/import/preview', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    try {
      const result = await (await getService()).preview();
      return reply.header('Cache-Control', 'no-store').send(result);
    } catch (err) {
      if (err instanceof PullError) return reply.status(409).send({ error: err.message, code: err.code });
      if (err instanceof ImportError) return reply.status(400).send({ error: err.message, code: err.code });
      logger.error({ errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-import: preview failed');
      return reply.status(500).send({ error: 'The preview failed. See the server log.' });
    }
  });

  app.post<{ Body: { runId?: unknown } }>('/api/contacts/import/apply', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const runId = request.body?.runId;
    if (typeof runId !== 'string' || !/^pull-[a-z0-9]+-[0-9a-f]{8}$/.test(runId)) {
      return reply.status(400).send({ error: 'runId from a preview is required' });
    }
    try {
      const result = await (await getService()).apply(runId);
      return reply.header('Cache-Control', 'no-store').send(result);
    } catch (err) {
      if (err instanceof PullError) return reply.status(err.code === 'unknown_run' ? 404 : 409).send({ error: err.message, code: err.code });
      if (err instanceof ImportError) return reply.status(409).send({ error: err.message, code: err.code });
      logger.error({ errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-import: apply failed');
      return reply.status(500).send({ error: 'The import failed. See the server log.' });
    }
  });
}
