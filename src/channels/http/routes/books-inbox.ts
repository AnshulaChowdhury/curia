// books-inbox.ts — the Google Drive folder of bank files, for the books agent and the connections page.
//
//   GET  /api/connections/drive             — signed-in person: folder status (never the key)
//   PUT  /api/connections/drive/settings    — signed-in person: save the service account key and the folder link
//   GET  /books/inbox                       — books token: the files waiting in the folder
//   GET  /books/inbox/:id/content           — books token: one file's bytes
//   POST /books/inbox/:id/processed         — books token: move the file to the Processed subfolder
//   POST /api/books/uploads?name=…          — signed-in person: upload a bank file (raw body)
//   GET  /api/books/uploads                 — signed-in person: the recent uploads and their state
//   DELETE /api/books/uploads/:id           — signed-in person: remove an upload that has not been taken yet
//
// /books/inbox lists the uploaded files and, if the Drive folder is set up, the files in it.
//
// Curia only stores and hands over bytes; the books agent on the Mac mini is what reads them.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { BooksToken } from '../../../quickbooks/books-token.js';
import { BankFileError, MAX_UPLOAD_BYTES, validateBankFile } from '../../../books/bank-file.js';
import { DriveFileError, DriveSettingsError, type DriveInbox } from '../../../books/drive-inbox.js';
import type { UploadStore } from '../../../books/upload-store.js';
import { booksAuth } from '../books-auth.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

export interface BooksInboxRouteOptions {
  logger: Logger;
  driveInbox: DriveInbox;
  uploads: UploadStore;
  booksToken: BooksToken;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

const FILE_ID = /^[\w-]{10,100}$/;

export async function booksInboxRoutes(app: FastifyInstance, options: BooksInboxRouteOptions): Promise<void> {
  const { logger, driveInbox, uploads, booksToken, webAppBootstrapSecret, sessions } = options;
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

  // The files waiting for the books run come from two places: files uploaded on the Books page (always), and the Google
  // Drive folder (only if it is set up and working). A broken Drive never hides the uploaded files.
  app.get('/books/inbox', RATE, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    const files = await uploads.listWaiting();
    try {
      files.push(...(await driveInbox.list()));
    } catch (err) {
      if (!(err instanceof DriveSettingsError)) logger.warn({ err }, 'books: Google Drive folder unavailable; listing uploads only');
    }
    return reply.header('Cache-Control', 'no-store').send({ files });
  });

  app.get<{ Params: { id: string } }>('/books/inbox/:id/content', RATE, async (request, reply) => {
    if (!(await authorised(request, reply))) return reply;
    if (!FILE_ID.test(request.params.id)) return reply.status(400).send({ error: 'Bad file id' });
    try {
      const bytes = isUuid(request.params.id)
        ? (await uploads.read(request.params.id))?.bytes
        : (await driveInbox.read(request.params.id)).bytes;
      if (!bytes) return reply.status(404).send({ error: 'No such file' });
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
      if (isUuid(request.params.id)) {
        if (!(await uploads.markProcessed(request.params.id))) return reply.status(404).send({ error: 'No such file' });
        logger.info({ uploadId: request.params.id }, 'books: uploaded bank file recorded; its bytes were deleted');
      } else {
        await driveInbox.markProcessed(request.params.id);
        logger.info({ fileId: request.params.id }, 'books: bank file moved to Processed');
      }
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // -- uploads from the Books page (owner session) --------------------------------------------------------------------
  // The file is sent as the raw request body (name in ?name=), so no multipart dependency is needed. The parser is
  // registered on this plugin only.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES + 1024 },
    (_req, body, done) => done(null, body));

  app.post<{ Querystring: { name?: string }; Body: Buffer }>(
    '/api/books/uploads',
    { bodyLimit: MAX_UPLOAD_BYTES + 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes)) return reply.status(400).send({ error: 'Send the file as the request body (application/octet-stream)' });
      try {
        const { name } = validateBankFile(request.query.name ?? '', bytes);
        const added = await uploads.add(name, bytes);
        if (added.status === 'duplicate') {
          return reply.header('Cache-Control', 'no-store').send({
            ok: true, duplicate: true, name: added.name,
            message: added.processed ? `${added.name} was already uploaded and has been processed` : `${added.name} is already waiting`,
          });
        }
        logger.info({ uploadId: added.id, size: bytes.length }, 'books: bank file uploaded');
        return reply.status(201).header('Cache-Control', 'no-store').send({ ok: true, id: added.id, name, size: bytes.length });
      } catch (err) {
        if (err instanceof BankFileError) return reply.status(400).send({ error: err.message });
        logger.error({ err }, 'books: saving an uploaded bank file failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  app.get('/api/books/uploads', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send({ uploads: await uploads.list() });
  });

  app.delete<{ Params: { id: string } }>('/api/books/uploads/:id', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: 'Bad file id' });
    if (!(await uploads.remove(request.params.id))) return reply.status(404).send({ error: 'That file is not waiting any more' });
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });
}
