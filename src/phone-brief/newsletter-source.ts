// newsletter-source.ts — the "newsletters" section: yesterday's mail that triage labelled Newsletter.
//
// Lists the Newsletter label's mail for yesterday (local day) in each connected mailbox, then reads each message's text
// (the same reader GET /phone/message uses) and asks the summarizer for a short summary. If the summary fails the item is
// still sent with sender and subject only. Read-only: GET requests to Nylas, nothing is written or marked.

import type { Logger } from '../logger.js';
import { triageGroupOfLabel } from '../inbox-triage/types.js';
import { NYLAS_REGIONS, NylasMailboxError, type NylasRegion } from '../phone-inbox/nylas-mailbox.js';
import { NylasMessageReader } from '../phone-inbox/nylas-message.js';
import { PHONE_INBOX_ACCOUNT_IDS } from '../phone-inbox/phone-inbox-service.js';
import type { NewsletterSummarizer } from './summarizer.js';
import type { UnsubscribeRecord } from '../inbox-triage/unsubscribe-store.js';
import { MAX_ITEMS_PER_SECTION, MAX_UNSUBSCRIBED, type BriefContext, type BriefItem, type BriefSource, type BriefUnsubscribed } from './types.js';

const PER_MAILBOX_LIMIT = 20;

interface NylasFolder { id: string; name?: string }
interface NylasListedMessage {
  id: string;
  thread_id?: string;
  subject?: string;
  date?: number;
  from?: Array<{ name?: string; email?: string }>;
}

interface Mailbox {
  accountId: string;
  apiKey: string;
  grantId: string;
  region: NylasRegion;
}

interface Found {
  mailbox: Mailbox;
  id: string;
  threadId: string;
  from: string;
  /** Lower-case sender address; '' when the message has none. */
  address: string;
  subject: string;
  date: number;
}

export interface NewsletterSourceDeps {
  secrets: { get(name: string): Promise<string | null> };
  summarizer: NewsletterSummarizer;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Senders the owner unsubscribed from. Their mail is listed apart instead of asking for a decision. Optional. */
  unsubscribes?: { getMany(accountId: string, senderAddresses: string[]): Promise<Map<string, UnsubscribeRecord>> };
}

export class NewsletterBriefSource implements BriefSource {
  readonly id = 'newsletters' as const;

  constructor(private readonly deps: NewsletterSourceDeps) {}

  async items(ctx: BriefContext): Promise<BriefItem[]> {
    return (await this.collect(ctx)).items;
  }

  async collect(ctx: BriefContext): Promise<{ items: BriefItem[]; unsubscribed: BriefUnsubscribed[] }> {
    const found: Found[] = [];
    for (const mailbox of await this.mailboxes()) {
      try {
        found.push(...(await this.listYesterday(mailbox, ctx)));
      } catch (err) {
        // One mailbox being unreachable only drops its newsletters.
        this.deps.logger.warn({ err, accountId: mailbox.accountId }, 'phone-brief: could not list newsletters');
      }
    }
    found.sort((a, b) => b.date - a.date);

    const { unsubscribed, remaining } = await this.splitUnsubscribed(found);
    const items: BriefItem[] = [];
    for (const message of remaining.slice(0, MAX_ITEMS_PER_SECTION)) {
      items.push({
        from: message.from, subject: message.subject, text: await this.summary(message),
        account: message.mailbox.accountId, messageId: message.id,
      });
    }
    return { items, unsubscribed };
  }

  /** Mail from senders the owner already unsubscribed from becomes one list entry per sender, not an item to decide on. */
  private async splitUnsubscribed(found: Found[]): Promise<{ unsubscribed: BriefUnsubscribed[]; remaining: Found[] }> {
    const store = this.deps.unsubscribes;
    if (!store) return { unsubscribed: [], remaining: found };
    const records = new Map<string, Map<string, UnsubscribeRecord>>();
    for (const accountId of new Set(found.map((f) => f.mailbox.accountId))) {
      const addresses = [...new Set(found.filter((f) => f.mailbox.accountId === accountId && f.address).map((f) => f.address))];
      try {
        records.set(accountId, await store.getMany(accountId, addresses));
      } catch (err) {
        // Without the records the mail is simply shown as before.
        this.deps.logger.warn({ err, accountId }, 'phone-brief: could not read the unsubscribed senders');
      }
    }

    const remaining: Found[] = [];
    const bySender = new Map<string, BriefUnsubscribed & { latest: number }>();
    for (const message of found) { // newest first
      const record = message.address ? records.get(message.mailbox.accountId)?.get(message.address) : undefined;
      if (!record) {
        remaining.push(message);
        continue;
      }
      const key = `${message.mailbox.accountId}:${message.address}`;
      const mailedAfter = message.date * 1000 > record.firstUnsubscribedAt.getTime();
      const seen = bySender.get(key);
      if (seen) {
        seen.stillSending = seen.stillSending || (mailedAfter && record.trashedAt === null);
        continue;
      }
      bySender.set(key, {
        from: message.from, account: message.mailbox.accountId, since: record.firstUnsubscribedAt.toISOString(),
        stillSending: mailedAfter && record.trashedAt === null, latest: message.date,
      });
    }
    const unsubscribed = [...bySender.values()]
      .sort((a, b) => b.latest - a.latest)
      .slice(0, MAX_UNSUBSCRIBED)
      .map(({ from, account, since, stillSending }) => ({ from, account, since, stillSending }));
    return { unsubscribed, remaining };
  }

  /** The mailboxes that have a Nylas grant. */
  private async mailboxes(): Promise<Mailbox[]> {
    const { secrets } = this.deps;
    const apiKey = (await secrets.get('nylas_api_key'))?.trim();
    const regionSetting = (await secrets.get('nylas_region'))?.trim().toLowerCase() || 'us';
    if (!apiKey || !(regionSetting in NYLAS_REGIONS)) return [];
    const region = regionSetting as NylasRegion; // checked against NYLAS_REGIONS above
    const out: Mailbox[] = [];
    for (const accountId of PHONE_INBOX_ACCOUNT_IDS) {
      const grantId = (await secrets.get(`phone_inbox_grant_${accountId.replace('-', '_')}`))?.trim();
      if (grantId) out.push({ accountId, apiKey, grantId, region });
    }
    return out;
  }

  private async listYesterday(mailbox: Mailbox, ctx: BriefContext): Promise<Found[]> {
    const folders = await this.get<NylasFolder[]>(mailbox, '/folders');
    const labelIds = (folders ?? []).filter((f) => triageGroupOfLabel(f.name ?? '') === 'newsletter').map((f) => f.id);
    const out: Found[] = [];
    for (const labelId of labelIds) {
      const query = new URLSearchParams({
        in: labelId,
        received_after: String(ctx.yesterday.start),
        received_before: String(ctx.yesterday.end),
        limit: String(PER_MAILBOX_LIMIT),
      });
      for (const m of (await this.get<NylasListedMessage[]>(mailbox, `/messages?${query}`)) ?? []) {
        out.push({
          mailbox,
          id: m.id,
          threadId: m.thread_id ?? '',
          from: m.from?.[0]?.name || m.from?.[0]?.email || '',
          address: (m.from?.[0]?.email ?? '').trim().toLowerCase(),
          subject: m.subject ?? '',
          date: m.date ?? 0,
        });
      }
    }
    return out;
  }

  /** The summary text, or undefined (sender and subject only) when the body or the model is unavailable. */
  private async summary(message: Found): Promise<string | undefined> {
    try {
      const { mailbox } = message;
      const reader = new NylasMessageReader(mailbox.apiKey, mailbox.grantId, this.deps.fetchImpl ?? fetch, mailbox.region);
      const body = await reader.read(message.threadId, message.id);
      if (!body?.body) return undefined;
      return (await this.deps.summarizer.summarize(body.body)) ?? undefined;
    } catch (err) {
      this.deps.logger.warn({ err, accountId: message.mailbox.accountId }, 'phone-brief: could not summarise a newsletter');
      return undefined;
    }
  }

  private async get<T>(mailbox: Mailbox, path: string): Promise<T | null> {
    const base = `${NYLAS_REGIONS[mailbox.region]}/v3/grants/${encodeURIComponent(mailbox.grantId)}`;
    const res = await (this.deps.fetchImpl ?? fetch)(`${base}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${mailbox.apiKey}`, Accept: 'application/json' },
    });
    // Status only; a response body can hold mail text and is never logged or surfaced.
    if (!res.ok) throw new NylasMailboxError(res.status, path.split('?')[0] ?? path);
    return ((await res.json()) as { data?: T }).data ?? null;
  }
}
