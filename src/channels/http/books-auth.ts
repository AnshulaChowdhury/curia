// books-auth.ts — bearer check for the books agent's routes (/books/*). The books token reaches those routes only.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../logger.js';
import type { BooksToken } from '../../quickbooks/books-token.js';

/** Returns a check that sends 404 (no token configured) or 401 itself and resolves false when the request is not allowed. */
export function booksAuth(booksToken: BooksToken, logger: Logger) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const ok = await booksToken.verify(provided);
    if (ok === null) {
      void reply.status(404).send({ error: 'Not found' });
      return false;
    }
    if (!provided || !ok) {
      logger.warn({ ip: request.ip, reason: provided ? 'invalid_token' : 'missing_token' }, 'books: auth failed');
      void reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };
}
