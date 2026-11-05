// phone-triage-preferences.ts — what the owner tells triage to remember about a sender, from the phone.
//
//   POST /phone/triage/preferences         { account, scope: "sender"|"domain", value, group } saves it (the answer to the
//                                          savePrompt on POST /phone/triage/review)
//   GET  /phone/triage/preferences         everything saved, so the owner can review it
//   POST /phone/triage/preferences/forget  { account, scope, value } removes one
//
// A saved preference becomes a hint for the classifier ("Earlier choice: Needs a reply"); it never labels mail by itself.
// Same bearer token as the other /phone routes; outside /api; no token → 404. Values are addresses and domains the owner
// chose to save: never logged.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { isTriageGroup, validPreferenceValue, type PgPreferenceStore, type PreferenceScope } from '../../../inbox-triage/preference-store.js';
import { PHONE_INBOX_ACCOUNT_IDS } from '../../../phone-inbox/phone-inbox-service.js';
import { authorisePhoneRequest } from './phone-auth.js';

export interface PhoneTriagePreferenceRouteOptions {
  logger: Logger;
  getToken: () => Promise<string | null>;
  store: Pick<PgPreferenceStore, 'save' | 'list' | 'remove'>;
}

function readTarget(body: Record<string, unknown>): { account: string; scope: PreferenceScope; value: string } | null {
  const account = PHONE_INBOX_ACCOUNT_IDS.find((id) => id === body.account);
  const scope = body.scope === 'sender' || body.scope === 'domain' ? body.scope : null;
  const value = typeof body.value === 'string' ? body.value.trim().toLowerCase() : '';
  if (!account || !scope || !validPreferenceValue(scope, value)) return null;
  return { account, scope, value };
}

export async function phoneTriagePreferenceRoutes(app: FastifyInstance, options: PhoneTriagePreferenceRouteOptions): Promise<void> {
  const { logger, getToken, store } = options;
  const RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/phone/triage/preferences', RATE, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-triage-preferences'))) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>; // shape checked field by field below
    const target = readTarget(body);
    if (!target || !isTriageGroup(body.group)) {
      return reply.status(400).send({ error: 'account, scope (sender or domain), a valid value and group are required' });
    }
    try {
      await store.save({ accountId: target.account, scope: target.scope, value: target.value, group: body.group });
      logger.info({ account: target.account, scope: target.scope, group: body.group }, 'phone-triage: preference saved');
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'phone-triage: could not save the preference');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  app.get('/phone/triage/preferences', RATE, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-triage-preferences'))) return reply;
    try {
      const items = await store.list();
      return reply.header('Cache-Control', 'no-store').send({
        preferences: items.map((p) => ({ account: p.accountId, scope: p.scope, value: p.value, group: p.group })),
      });
    } catch (err) {
      logger.error({ err }, 'phone-triage: could not list the preferences');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  app.post('/phone/triage/preferences/forget', RATE, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-triage-preferences'))) return reply;
    const target = readTarget((request.body ?? {}) as Record<string, unknown>); // shape checked field by field in readTarget
    if (!target) return reply.status(400).send({ error: 'account, scope (sender or domain) and a valid value are required' });
    try {
      if (!(await store.remove(target.account, target.scope, target.value))) return reply.status(404).send({ error: 'Not saved' });
      logger.info({ account: target.account, scope: target.scope }, 'phone-triage: preference removed');
      return reply.status(204).send();
    } catch (err) {
      logger.error({ err }, 'phone-triage: could not remove the preference');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
