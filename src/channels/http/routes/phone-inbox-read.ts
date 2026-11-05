// phone-inbox-read.ts — POST /phone/inbox/read: the phone marks threads as seen, and Curia marks them READ in the mailbox.
//
// Same bearer token as the other /phone routes (vault secret `phone_inbox_token`); outside /api; no token → 404.
// A second mailbox write the phone may trigger, approved by the owner (2026-11-02): it only ever marks a thread read.
// It never changes triage labels, archives, deletes or marks mail unread. Idempotent: marking a read thread again is fine,
// and a thread that no longer exists counts as done.
// Contract: contracts/phone-inbox.openapi.yaml in the MVOS repo (path /phone/inbox/read).

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { MailboxRateLimitedError, PHONE_INBOX_ACCOUNT_IDS, type PhoneInboxAccountId } from '../../../phone-inbox/phone-inbox-service.js';
import { authorisePhoneRequest } from './phone-auth.js';

export interface PhoneInboxReadRouteOptions {
  logger: Logger;
  getToken: () => Promise<string | null>;
  /** The marker for one mailbox, or null when that mailbox is not connected. */
  getMarker: (account: PhoneInboxAccountId) => Promise<{ markRead(threadId: string): Promise<true> } | null>;
  /** Drops the account's cached /phone/inbox answer so a thread marked read stops counting on the next poll. */
  invalidate: (account: PhoneInboxAccountId) => void;
}

const MAX_ITEMS = 50;
const MAX_ID_LENGTH = 256;

interface Item { account: PhoneInboxAccountId; threadId: string }

/** The items array, de-duplicated, or null when anything in it is malformed. */
function parseItems(body: unknown): Item[] | null {
  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) return null;
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as { account?: unknown; threadId?: unknown };
    const account = PHONE_INBOX_ACCOUNT_IDS.find((id) => id === e.account);
    if (!account || typeof e.threadId !== 'string' || e.threadId.length === 0 || e.threadId.length > MAX_ID_LENGTH) return null;
    const key = `${account}\u0000${e.threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ account, threadId: e.threadId });
  }
  return items;
}

export async function phoneInboxReadRoutes(app: FastifyInstance, options: PhoneInboxReadRouteOptions): Promise<void> {
  const { logger, getToken, getMarker, invalidate } = options;

  // "Mark all as seen" sends up to 50 threads in one call; 20 calls a minute is plenty and still blocks guessing.
  app.post('/phone/inbox/read', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-inbox-read'))) return reply;

    const items = parseItems(request.body);
    if (!items) return reply.status(400).send({ error: 'items must be 1 to 50 entries of { account, threadId }' });

    try {
      const markers = new Map<PhoneInboxAccountId, Awaited<ReturnType<typeof getMarker>>>();
      for (const account of new Set(items.map((i) => i.account))) markers.set(account, await getMarker(account));
      if ([...markers.values()].every((m) => m === null)) return reply.status(503).send({ error: 'Mailbox not connected' });

      let marked = 0;
      const failedItems: Item[] = [];
      let rateLimited = 0;
      const touched = new Set<PhoneInboxAccountId>();
      for (const item of items) {
        const marker = markers.get(item.account);
        if (!marker) {
          failedItems.push(item);
          continue;
        }
        try {
          await marker.markRead(item.threadId);
          marked += 1;
          touched.add(item.account);
        } catch (err) {
          if (err instanceof MailboxRateLimitedError) rateLimited += 1;
          // Status only; the error carries no email content.
          logger.warn({ account: item.account, err }, 'phone-inbox-read: could not mark a thread read');
          failedItems.push(item);
        }
      }
      for (const account of touched) invalidate(account);

      // Nothing could be written: the phone keeps its local mark and retries later.
      if (marked === 0) {
        const connected = items.some((i) => markers.get(i.account));
        return reply.status(connected ? 502 : 503).send({ error: rateLimited > 0 ? 'Mailbox busy' : 'Could not mark the mail read' });
      }
      return reply.header('Cache-Control', 'no-store').send({ ok: true, marked, failed: failedItems.length, failedItems });
    } catch (err) {
      logger.error({ err }, 'phone-inbox-read: unexpected failure');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
