// phone-triage.ts — the phone's review cards for mail triage could not sort.
//
//   GET  /phone/triage/review   one card per unsorted email, each with the category options
//   POST /phone/triage/review   { account, messageId, group } applies that category, or group "dismiss" to leave it unlabelled;
//                               the answer may carry a savePrompt (see POST /phone/triage/preferences)
//
// Same bearer token as the other /phone routes (vault secret `phone_inbox_token`); outside /api; no token → 404.
// Unlike /phone/books/review this one writes: choosing a category adds the triage label to the email in the mailbox
// (and marks newsletter or spam mail read), exactly as automatic triage would. Sender, subject and preview are
// untrusted mail text: capped, control characters stripped, plain text only.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { UnsortedItem } from '../../../inbox-triage/item-store.js';
import { TRIAGE_GROUPS, TRIAGE_LABELS, type TriageGroup } from '../../../inbox-triage/types.js';
import { extractKeywords } from '../../../inbox-triage/keywords.js';
import { addressParts, isSharedMailDomain } from '../../../inbox-triage/preference-store.js';
import { cleanText } from '../../../phone-brief/brief-service.js';
import { authorisePhoneRequest } from './phone-auth.js';

export interface PhoneTriageRouteOptions {
  logger: Logger;
  getToken: () => Promise<string | null>;
  store: {
    listUnsorted(limit: number): Promise<UnsortedItem[]>;
    countUnsorted(): Promise<number>;
    getUnsorted(accountId: string, messageId: string): Promise<UnsortedItem | null>;
    resolve(accountId: string, messageId: string, group: string | null): Promise<boolean>;
  };
  /** The mailbox for an account, or null when it is not connected. */
  getSource: (accountId: string) => Promise<{ applyLabel(messageId: string, group: TriageGroup): Promise<void> } | null>;
}

const MAX_CARDS = 50;
export const DISMISS = 'dismiss';

/** The buttons on every card: the five categories, then "dismiss" (leave it as it is). */
export const REVIEW_OPTIONS = [
  ...TRIAGE_GROUPS.map((group) => ({ group: group as string, label: TRIAGE_LABELS[group] })),
  { group: DISMISS, label: 'Leave as is' },
];

/**
 * The follow-up question after a category was chosen: "save this for next time?". Null when the sender's address is
 * unknown. The domain choice is left out for shared mail providers (gmail.com and the like). The phone sends the answer
 * to POST /phone/triage/preferences; "not now" is simply not calling it.
 */
function savePromptFor(item: UnsortedItem, group: TriageGroup) {
  const parts = addressParts(item.fromAddress);
  if (!parts) return null;
  const label = TRIAGE_LABELS[group];
  // Words picked from this email's subject and preview. The phone shows them for the owner to keep or drop.
  const keywords = extractKeywords(item.subject, item.snippet);
  return {
    group,
    question: `Save this for next time? File mail like this as "${label}".`,
    options: [
      { scope: 'sender', value: parts.address, label: `From ${parts.address}` },
      ...(keywords.length > 0
        ? [{ scope: 'sender-keywords', value: parts.address, label: `From ${parts.address} about ${keywords.join(', ')}`, keywords }]
        : []),
      ...(isSharedMailDomain(parts.domain) ? [] : [{ scope: 'domain', value: parts.domain, label: `Anyone at ${parts.domain}` }]),
    ],
  };
}

const cardId = (accountId: string, messageId: string): string => `${accountId}:${messageId}`;

function toCard(item: UnsortedItem) {
  return {
    id: cardId(item.accountId, item.messageId),
    account: item.accountId,
    messageId: item.messageId,
    threadId: item.threadId,
    from: cleanText(item.from, 120),
    subject: cleanText(item.subject, 200),
    preview: cleanText(item.snippet, 300),
    receivedAt: item.receivedAt,
    reason: item.reason,
    options: REVIEW_OPTIONS,
  };
}

export async function phoneTriageRoutes(app: FastifyInstance, options: PhoneTriageRouteOptions): Promise<void> {
  const { logger, getToken, store, getSource } = options;

  app.get('/phone/triage/review', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-triage'))) return reply;
    try {
      const [items, count] = await Promise.all([store.listUnsorted(MAX_CARDS), store.countUnsorted()]);
      // Sender, subject and preview of real mail: keep it out of any shared cache.
      return reply.header('Cache-Control', 'no-store').send({ generatedAt: new Date().toISOString(), count, cards: items.map(toCard) });
    } catch (err) {
      logger.error({ err }, 'phone-triage: could not list the unsorted mail');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  app.post('/phone/triage/review', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-triage'))) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>; // shape checked field by field below
    const account = typeof body.account === 'string' ? body.account : '';
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const choice = typeof body.group === 'string' ? body.group : '';
    const isGroup = (TRIAGE_GROUPS as readonly string[]).includes(choice);
    if (!account || !messageId || (!isGroup && choice !== DISMISS)) {
      return reply.status(400).send({ error: 'account, messageId and group (a category, or "dismiss") are required' });
    }

    try {
      const item = await store.getUnsorted(account, messageId);
      if (!item) return reply.status(404).send({ error: 'Not waiting for a category' });

      if (isGroup) {
        const source = await getSource(account);
        if (!source) return reply.status(503).send({ error: 'Mailbox not connected' });
        try {
          await source.applyLabel(messageId, choice as TriageGroup); // checked against TRIAGE_GROUPS above
        } catch (err) {
          // The card stays, so the owner can try again.
          logger.warn({ err, account, group: choice }, 'phone-triage: could not apply the label');
          return reply.status(502).send({ error: 'Could not label the email' });
        }
      }
      await store.resolve(account, messageId, isGroup ? choice : null);
      logger.info({ account, group: isGroup ? choice : DISMISS }, 'phone-triage: resolved from the phone');
      const savePrompt = isGroup ? savePromptFor(item, choice as TriageGroup) : null; // choice checked against TRIAGE_GROUPS above
      return reply.header('Cache-Control', 'no-store').send({
        ok: true,
        id: cardId(account, messageId),
        remaining: await store.countUnsorted(),
        ...(savePrompt ? { savePrompt } : {}),
      });
    } catch (err) {
      logger.error({ err }, 'phone-triage: unexpected failure');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
