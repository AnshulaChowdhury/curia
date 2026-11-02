// phone-mailbox-category.ts — PUT /phone/inbox/accounts/:accountId/category
//
// Command Hub (the phone launcher) tells Curia whether each of its mailboxes is Work or Personal. The phone is the
// source of truth; Curia keeps the last value it was told and never changes it. Only the account id and the category
// cross this route: no address, no mail. Same token as the other /phone routes; outside /api; no token → 404.
// Contract: contracts/phone-inbox.openapi.yaml in the MVOS repo.
//   204 stored (or unchanged) · 400 unknown category · 401 bad token · 404 unknown account (or phone routes off)

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { isMailboxCategory, isPhoneInboxAccountId, type MailboxCategoryStore } from '../../../phone-inbox/mailbox-category-store.js';
import { authorisePhoneRequest } from './phone-auth.js';

export interface PhoneMailboxCategoryRouteOptions {
  logger: Logger;
  getToken: () => Promise<string | null>;
  store: MailboxCategoryStore;
}

export async function phoneMailboxCategoryRoutes(app: FastifyInstance, options: PhoneMailboxCategoryRouteOptions): Promise<void> {
  const { logger, getToken, store } = options;

  // The phone sends on change and weekly; 30/min leaves room for a retry after a failure and still blocks guessing.
  app.put<{ Params: { accountId: string } }>(
    '/phone/inbox/accounts/:accountId/category',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-mailbox-category'))) return reply;

      const accountId = request.params.accountId;
      if (!isPhoneInboxAccountId(accountId)) return reply.status(404).send({ error: 'Unknown account' });

      const body = (request.body ?? {}) as Record<string, unknown>; // shape checked field by field below
      if (!isMailboxCategory(body.category) || Object.keys(body).some((key) => key !== 'category')) {
        return reply.status(400).send({ error: 'category must be WORK or PERSONAL' });
      }

      try {
        const { changed } = await store.report(accountId, body.category);
        // One line per change of value. Account id and category only: never an address, never the token.
        if (changed) logger.info({ accountId, category: body.category }, 'phone-mailbox-category: category changed');
        return reply.status(204).send();
      } catch (err) {
        logger.error({ err }, 'phone-mailbox-category: could not store the category');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );
}
