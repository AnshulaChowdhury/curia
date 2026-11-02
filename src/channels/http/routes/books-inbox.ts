// books-inbox.ts — the Google Drive folder of bank files, for the books agent and the connections page.
//
//   GET  /api/connections/drive             — signed-in person: folder status (never the key)
//   PUT  /api/connections/drive/settings    — signed-in person: save the service account key and the folder link
//   GET  /books/inbox                       — books token: the files waiting in the folder
//   GET  /books/inbox/:id/content           — books token: one file's bytes
//   POST /books/inbox/:id/processed         — books token: move the file to the Processed subfolder
//
// Curia only stores and hands over bytes; the books agent on the Mac mini is what reads them.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { BooksToken } from '../../../quickbooks/books-token.js';
import { DriveFileError, DriveSettingsError, type DriveInbox } from '../../../books/drive-inbox.js';
import { booksAuth } from '../books-auth.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface BooksInboxRouteOptions {
  logger: Logger;
  driveInbox: DriveInbox;
  booksToken: BooksToken;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

const FILE_ID = /^[\w-]{10,100}$/;

export async function booksInboxRoutes(app: FastifyInstance, options: BooksInboxRouteOptions): Promise<void> {
  const { logger, driveInbox, booksToken, webAppBootstrapSecret, sessions } = options;
  const RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const authorised = booksAuth(booksToken, logger);

  app.get('/api/connections/drive', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send(await driveInbox.status());
  });

  // The key is accepted once and stored encrypted; it is never returned.
  app.put<{ Body: { serviceAccountJson?: unknown; folder?: unknown } }>(
    '/api/connections/drive/settings',
    { bodyLimit: 32 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
      try {
        const saved = await driveInbox.saveSettings(request.body ?? {});
        logger.info({ serviceAccount: saved.serviceAccountEmail }, 'books: bank files folder saved');
        return reply.header('Cache-Control', 'no-store').send({ ok: true, ...saved });
      } catch (err) {
        if (err instanceof DriveSettingsError) return reply.status(400).send({ error: err.message });
        logger.error({ err }, 'books: saving the bank files folder failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DriveSettingsError) return reply.status(409).send({ error: 'not_configured', message: err.message });
    if (err instanceof DriveFileError) return reply.status(404).send({ error: err.message });
    logger.error({ err }, 'books: bank files folder call failed');
    return reply.status(502).send({ error: 'Google Drive is unavailable' });
  };

  app.get('/books/inbox', RATE, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    try {
      return reply.header('Cache-Control', 'no-store').send({ files: await driveInbox.list() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/books/inbox/:id/content', RATE, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    if (!FILE_ID.test(request.params.id)) return reply.status(400).send({ error: 'Bad file id' });
    try {
      const { bytes } = await driveInbox.read(request.params.id);
      // Bank data: never cache; opaque bytes, never rendered by a browser.
      return reply.header('Cache-Control', 'no-store').header('Content-Type', 'application/octet-stream').header('X-Content-Type-Options', 'nosniff').send(bytes);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/books/inbox/:id/processed', RATE, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    if (!FILE_ID.test(request.params.id)) return reply.status(400).send({ error: 'Bad file id' });
    try {
      await driveInbox.markProcessed(request.params.id);
      logger.info({ fileId: request.params.id }, 'books: bank file moved to Processed');
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
