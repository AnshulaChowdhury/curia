// contacts-sources.ts — GET /api/contacts/import/sources: the list behind the Contacts page "Sources" drawer.
//
// Read-only, session auth like the other console routes. Mailboxes come from the phone-inbox accounts (the vault),
// each mailbox's Work/Personal category from what Command Hub reported, bridges from the saved bridge settings.
// Nothing here reaches out to Nylas or a bridge: it only reads what is already stored. Addresses are masked and no
// secret is ever returned.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { SecretsService } from '../../../secrets/secrets-service.js';
import { BRIDGES, bridgeVaultKeys } from '../../../contacts-import/bridges.js';
import { buildSources } from '../../../contacts-import/sources.js';
import type { MailboxCategoryStore } from '../../../phone-inbox/mailbox-category-store.js';
import type { PhoneInboxAccountConfig } from '../../../phone-inbox/phone-inbox-service.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface ContactsSourcesRouteOptions {
  logger: Logger;
  secrets: Pick<SecretsService, 'get'>;
  categories: Pick<MailboxCategoryStore, 'list'>;
  /** The phone-inbox mailboxes (address and whether a grant exists). Nothing is fetched from Nylas. */
  loadMailboxes: () => Promise<Pick<PhoneInboxAccountConfig, 'id' | 'address' | 'reader'>[]>;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function contactsSourcesRoutes(app: FastifyInstance, options: ContactsSourcesRouteOptions): Promise<void> {
  const { logger, secrets, categories, loadMailboxes, webAppBootstrapSecret, sessions } = options;

  app.get('/api/contacts/import/sources', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    try {
      const [mailboxes, reported] = await Promise.all([loadMailboxes(), categories.list()]);
      const bridges = [];
      for (const b of BRIDGES) {
        const k = bridgeVaultKeys(b.id);
        bridges.push({
          id: b.id,
          label: b.label,
          hasUrl: ((await secrets.get(k.url))?.trim() ?? '') !== '',
          hasSecret: ((await secrets.get(k.secret))?.trim() ?? '') !== '',
        });
      }
      const sources = buildSources({
        mailboxes: mailboxes.map((m) => ({ id: m.id, address: m.address, connected: m.reader !== null })),
        categories: reported,
        bridges,
      });
      return reply.header('Cache-Control', 'no-store').send({ sources });
    } catch (err) {
      logger.error({ err }, 'contacts-sources: could not build the list');
      return reply.status(500).send({ error: 'Could not load the sources' });
    }
  });
}
