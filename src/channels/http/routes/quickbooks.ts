// quickbooks.ts — the QuickBooks connection and the narrow API the books agent on the Mac mini uses.
//
//   GET  /api/connections       — signed-in person only: the API connections and their status, for the Settings page
//   GET  /books/qbo/connect     — signed-in person only (session cookie): redirects to Intuit to authorise
//   GET  /books/qbo-callback    — where Intuit sends the browser back; the single-use `state` is the credential
//   GET  /books/qbo/status      — books token: is QuickBooks connected
//   POST /books/qbo/query       — books token: a read-only `select ... from <entity>`
//   POST /books/qbo/create      — books token: create a Purchase, Deposit, Transfer or Vendor (idempotent by request_id)
//
// Outside /api on purpose, like /phone/inbox: the books token (env BOOKS_API_TOKEN) works for these routes only and the
// main API_TOKEN does not work here. QuickBooks tokens never leave Curia. Without BOOKS_API_TOKEN the machine routes are 404.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';
import { QboApiError, QboAuthError, type QboConnection } from '../../../quickbooks/qbo-connection.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

const READABLE = new Set([
  'Account', 'Class', 'Department', 'TaxCode', 'Vendor', 'Customer', 'Purchase', 'Deposit', 'Transfer',
  'Preferences', 'CompanyInfo', 'Item',
]);
const CREATABLE = new Set(['Purchase', 'Deposit', 'Transfer', 'Vendor']);
const SELECT_RX = /^select\s+[\w*,\s().]+?\s+from\s+(\w+)(\s|$)/i;

export interface QuickbooksRouteOptions {
  logger: Logger;
  connection: QboConnection;
  /** The books token, read per request; null when not configured. */
  getToken: () => string | null;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
}

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`;

export async function quickbooksRoutes(app: FastifyInstance, options: QuickbooksRouteOptions): Promise<void> {
  const { logger, connection, getToken, webAppBootstrapSecret, sessions } = options;
  const RATE = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  // The console's API connections page. Session auth like the other console routes; never returns a token.
  app.get('/api/connections', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const status = await connection.status();
    return reply.header('Cache-Control', 'no-store').send({
      connections: [{
        id: 'quickbooks',
        name: 'QuickBooks Online',
        description: 'MowMow Ventures books. Curia holds the authorisation and the books agent posts through it.',
        ...status,
        connectUrl: '/books/qbo/connect',
      }],
    });
  });

  // A person starts the connection from a browser that is signed in to Curia.
  app.get('/books/qbo/connect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    try {
      return reply.header('Cache-Control', 'no-store').redirect(connection.authorizationUrl());
    } catch (err) {
      if (err instanceof QboAuthError) return reply.status(503).type('text/html').send(page('QuickBooks is not set up', err.message));
      throw err;
    }
  });

  // Intuit sends the browser here. No session needed: the state we issued is single-use and expires in ten minutes.
  app.get<{ Querystring: { code?: string; realmId?: string; state?: string; error?: string } }>(
    '/books/qbo-callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store').type('text/html');
      try {
        await connection.handleCallback(request.query);
        return reply.send(page('QuickBooks is connected', 'You can close this tab. The books system can now post to QuickBooks.'));
      } catch (err) {
        if (err instanceof QboAuthError) {
          logger.warn({ reason: err.message }, 'quickbooks: callback rejected');
          return reply.status(400).send(page('QuickBooks was not connected', err.message));
        }
        logger.error({ err }, 'quickbooks: callback failed');
        return reply.status(500).send(page('QuickBooks was not connected', 'Something went wrong on our side. Try again.'));
      }
    },
  );

  // Everything below is for the books agent and needs the books token.
  const authorised = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const expected = getToken()?.trim();
    if (!expected) {
      void reply.status(404).send({ error: 'Not found' });
      return false;
    }
    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!provided || !tokensMatch(provided, expected)) {
      logger.warn({ ip: request.ip, reason: provided ? 'invalid_token' : 'missing_token' }, 'books: auth failed');
      void reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof QboAuthError) return reply.status(409).send({ error: 'not_connected', message: err.message });
    if (err instanceof QboApiError) {
      logger.warn({ status: err.status, message: err.message }, 'books: QuickBooks error');
      return reply.status(err.status >= 400 && err.status < 500 ? 422 : 502).send({ error: 'quickbooks', status: err.status, message: err.message, fault: err.fault });
    }
    logger.error({ err }, 'books: unexpected failure');
    return reply.status(500).send({ error: 'Internal error' });
  };

  app.get('/books/qbo/status', RATE, async (request, reply) => {
    if (!authorised(request, reply)) return reply;
    return reply.header('Cache-Control', 'no-store').send(await connection.status());
  });

  app.post<{ Body: { query?: unknown } }>('/books/qbo/query', RATE, async (request, reply) => {
    if (!authorised(request, reply)) return reply;
    const q = typeof request.body?.query === 'string' ? request.body.query.trim() : '';
    const m = SELECT_RX.exec(q);
    if (!m || !READABLE.has(m[1]!) || q.length > 1000 || q.includes(';')) {
      return reply.status(400).send({ error: 'Only a single select on a known entity is allowed' });
    }
    try {
      return reply.header('Cache-Control', 'no-store').send(await connection.api('GET', 'query', { query: q }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: { entity?: unknown; payload?: unknown; request_id?: unknown } }>('/books/qbo/create', RATE, async (request, reply) => {
    if (!authorised(request, reply)) return reply;
    const { entity, payload, request_id: requestId } = request.body ?? {};
    if (typeof entity !== 'string' || !CREATABLE.has(entity)) {
      return reply.status(400).send({ error: `entity must be one of ${[...CREATABLE].join(', ')}` });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply.status(400).send({ error: 'payload must be an object' });
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w.-]{1,50}$/.test(requestId))) {
      return reply.status(400).send({ error: 'request_id must be 1-50 letters, digits, dots, dashes or underscores' });
    }
    try {
      const params: Record<string, string> = requestId ? { requestid: requestId } : {};
      const out = await connection.api('POST', entity.toLowerCase(), params, payload);
      logger.info({ entity, requestId }, 'books: created in QuickBooks');
      return reply.header('Cache-Control', 'no-store').send(out);
    } catch (err) {
      return fail(reply, err);
    }
  });
}
