// budget-banks.ts — connecting banks to the personal budget through Plaid, owner only.
//
//   GET    /api/budget/banks               — { configured, links[] }: each link's bank, accounts, status and last sync
//   POST   /api/budget/banks/link-token    — { linkToken } for the browser's Plaid Link window
//   POST   /api/budget/banks               — { publicToken, institution }: store the connection and run its first sync.
//                                            `notice` names accounts left out as already connected; 409 if that is all of them
//   POST   /api/budget/banks/:id/link-token — { linkToken } to log in to an existing connection's bank again
//   POST   /api/budget/banks/sync          — sync every active link now
//   POST   /api/budget/banks/:id/sync      — sync one link now
//   DELETE /api/budget/banks/:id           — disconnect: revoke at Plaid, delete the stored token and the link
//
// The Plaid access token is never returned by any route. Plaid's own messages are passed on only as a code and a short
// sentence.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import { DuplicateAccountsError, type BankSync } from '../../../budget/bank-sync.js';
import { PlaidError, type PlaidClient } from '../../../budget/plaid-client.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

export interface BudgetBanksRouteOptions {
  logger: Logger;
  sync: Pick<BankSync, 'list' | 'connect' | 'reconnectToken' | 'syncOne' | 'syncAll' | 'remove'>;
  plaid: Pick<PlaidClient, 'configured' | 'createLinkToken'>;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

export async function budgetBanksRoutes(app: FastifyInstance, options: BudgetBanksRouteOptions): Promise<void> {
  const { logger, sync, plaid, webAppBootstrapSecret, sessions } = options;
  const RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const owner = (request: Parameters<typeof assertSecret>[0], reply: FastifyReply): boolean => assertSecret(request, reply, webAppBootstrapSecret, sessions);
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DuplicateAccountsError) return reply.status(409).send({ error: err.message, code: 'DUPLICATE_ACCOUNTS' });
    if (err instanceof PlaidError) {
      logger.warn({ code: err.code, status: err.status }, 'budget: Plaid call failed');
      const status = err.code === 'NOT_CONFIGURED' ? 400 : err.status === 404 ? 404 : 502;
      return reply.status(status).send({ error: err.message, code: err.code });
    }
    logger.error({ err }, 'budget: bank call failed');
    return reply.status(500).send({ error: 'Internal error' });
  };

  app.get('/api/budget/banks', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).send({ configured: await plaid.configured(), links: await sync.list() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/budget/banks/link-token', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      return noStore(reply).send({ linkToken: await plaid.createLinkToken('owner') });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: Record<string, unknown> }>('/api/budget/banks', { bodyLimit: 8 * 1024, ...RATE }, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const publicToken = request.body?.['publicToken'];
    const institution = request.body?.['institution'];
    if (typeof publicToken !== 'string' || publicToken.length < 10 || publicToken.length > 300) return reply.status(400).send({ error: 'publicToken is required' });
    try {
      return noStore(reply).status(201).send({ ok: true, ...(await sync.connect(publicToken, typeof institution === 'string' ? institution : '')) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/budget/banks/:id/link-token', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: 'Bad id' });
    try {
      return noStore(reply).send({ linkToken: await sync.reconnectToken(request.params.id) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/budget/banks/sync', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    try {
      await sync.syncAll();
      return noStore(reply).send({ ok: true, links: await sync.list() });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/budget/banks/:id/sync', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: 'Bad id' });
    try {
      return noStore(reply).send({ ok: true, added: await sync.syncOne(request.params.id) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/budget/banks/:id', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: 'Bad id' });
    try {
      return (await sync.remove(request.params.id)) ? noStore(reply).send({ ok: true }) : reply.status(404).send({ error: 'No such bank link' });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
