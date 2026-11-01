// phone-inbox-service.ts — builds the answer for GET /phone/inbox (Command Hub's Email row).
//
// "Needs you" = tagged Urgent, Seen or Drafted by the ceo-inbox triage, still unread, still in the
// inbox, and no reply from the principal in that thread since. State is read fresh on every request,
// so replying, archiving or opening an email removes it. Only sender, subject, group, time and ids
// leave this module — never bodies, snippets or attachments (contract: contracts/phone-inbox.openapi.yaml).

import type { Logger } from '../logger.js';

export const PHONE_INBOX_ACCOUNT_IDS = ['personal', 'moonray', 'work-outlook'] as const;
export type PhoneInboxAccountId = (typeof PHONE_INBOX_ACCOUNT_IDS)[number];

export type PhoneInboxGroup = 'urgent' | 'seen' | 'drafted';

/** One unread inbox message, with its folder/label ids already resolved to display names. */
export interface InboxMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string | undefined;
  fromEmail: string | undefined;
  /** Unix seconds. */
  date: number;
  folderNames: string[];
}

/** A message the principal sent: only the thread and time matter for reply detection. */
export interface SentMessage {
  threadId: string;
  /** Unix seconds. */
  date: number;
}

/** Read-only view of one mailbox. Implemented over Nylas; faked in tests. */
export interface MailboxReader {
  /** Unread messages currently in the inbox, newest first. */
  unreadInbox(): Promise<InboxMessage[]>;
  /** Messages the principal sent on or after [sinceSeconds]. */
  sentSince(sinceSeconds: number): Promise<SentMessage[]>;
}

export interface PhoneInboxAccountConfig {
  id: PhoneInboxAccountId;
  /** The mailbox address, or null until it is configured (the phone then shows a generic label). */
  address: string | null;
  /** Null when the account has no grant yet: it is still listed, empty. */
  reader: MailboxReader | null;
}

export interface PhoneInboxItem {
  from: string;
  subject: string;
  group: PhoneInboxGroup;
  receivedAt: string;
  threadId: string;
  /** Outlook only: lets the phone try to open one message. */
  messageId?: string;
}

export interface PhoneInboxAccount {
  id: PhoneInboxAccountId;
  address: string | null;
  /**
   * False when this mailbox isn't connected (no Nylas grant, e.g. an employer that blocks third-party
   * access). Its counts are then 0 because nothing was read, not because it is clear; the phone says so.
   */
  syncing: boolean;
  needsYou: number;
  unread: number;
  items: PhoneInboxItem[];
}

export interface PhoneInbox {
  updatedAt: string;
  accounts: PhoneInboxAccount[];
}

/** How far back a sent reply counts. Older unread mail with no recent reply still needs you. */
const REPLY_LOOKBACK_SECONDS = 14 * 24 * 60 * 60;

/** Matches the triage labels ("🚨 Urgent", "✍️ Drafted", "📌 Seen") ignoring emoji and case. */
export function groupOfLabel(name: string): PhoneInboxGroup | null {
  const letters = name.replace(/[^\p{L}]/gu, '').toLowerCase();
  if (letters === 'urgent' || letters === 'drafted' || letters === 'seen') return letters;
  return null;
}

// Most pressing first when a message carries more than one triage label.
const GROUP_PRIORITY: PhoneInboxGroup[] = ['urgent', 'drafted', 'seen'];

function groupOf(folderNames: string[]): PhoneInboxGroup | null {
  const found = new Set(folderNames.map(groupOfLabel).filter((g): g is PhoneInboxGroup => g !== null));
  return GROUP_PRIORITY.find((g) => found.has(g)) ?? null;
}

function senderOf(message: InboxMessage): string {
  return message.fromName?.trim() || message.fromEmail?.trim() || '';
}

/** A mailbox read was refused because the provider is rate limiting us (HTTP 429). */
export class MailboxRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number | undefined) {
    super('Mailbox provider is rate limiting requests');
    this.name = 'MailboxRateLimitedError';
  }
}

// An answer younger than this is served as is, so a phone that refreshes often costs the provider nothing.
const FRESH_MS = 60_000;
// If a read fails we keep serving the last good answer for this long, then say "not syncing".
const STALE_MAX_MS = 30 * 60_000;
// After a 429 we leave the provider alone for at least this long (or its Retry-After, if longer).
const MIN_COOLDOWN_MS = 60_000;

/** What we know between requests: the last good answer per mailbox, and when each is allowed to be asked again. */
export class PhoneInboxCache {
  readonly good = new Map<string, { account: PhoneInboxAccount; at: number }>();
  readonly blockedUntil = new Map<string, number>();
}

export class PhoneInboxUnavailableError extends Error {
  constructor(public readonly accountId: PhoneInboxAccountId, cause: unknown) {
    super(`Could not read the ${accountId} mailbox`, { cause });
    this.name = 'PhoneInboxUnavailableError';
  }
}

export class PhoneInboxService {
  constructor(
    private readonly accounts: PhoneInboxAccountConfig[],
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly cache: PhoneInboxCache = new PhoneInboxCache(),
  ) {}

  /**
   * Builds the current answer. A mailbox that can't be read doesn't fail the others: we serve its last
   * good answer for up to 30 minutes, then report it as not syncing (never as "0 need you", which would
   * look like all clear). A rate-limited mailbox is left alone until its cool-down ends.
   */
  async build(): Promise<PhoneInbox> {
    const now = this.now();
    const accounts = await Promise.all(this.accounts.map((account) => this.buildAccount(account, now)));
    return { updatedAt: now.toISOString(), accounts };
  }

  private async buildAccount(account: PhoneInboxAccountConfig, now: Date): Promise<PhoneInboxAccount> {
    const { id, address, reader } = account;
    if (!reader) return { id, address, syncing: false, needsYou: 0, unread: 0, items: [] };

    const nowMs = now.getTime();
    const cached = this.cache.good.get(id);
    if (cached && nowMs - cached.at < FRESH_MS) return cached.account;
    if ((this.cache.blockedUntil.get(id) ?? 0) > nowMs) return this.fallback(account, cached, nowMs);

    try {
      const built = await this.readAccount(account, reader, now);
      this.cache.good.set(id, { account: built, at: nowMs });
      this.cache.blockedUntil.delete(id);
      return built;
    } catch (err) {
      // Log the failure without any message content.
      if (err instanceof MailboxRateLimitedError) {
        const waitMs = Math.max(MIN_COOLDOWN_MS, (err.retryAfterSeconds ?? 0) * 1000);
        this.cache.blockedUntil.set(id, nowMs + waitMs);
        this.logger.warn({ account: id, retryAfterSeconds: err.retryAfterSeconds }, 'phone-inbox: mailbox rate limited; backing off');
      } else {
        this.logger.error({ err, account: id }, 'phone-inbox: mailbox read failed');
      }
      return this.fallback(account, cached, nowMs);
    }
  }

  private fallback(
    account: PhoneInboxAccountConfig,
    cached: { account: PhoneInboxAccount; at: number } | undefined,
    nowMs: number,
  ): PhoneInboxAccount {
    if (cached && nowMs - cached.at <= STALE_MAX_MS) return cached.account;
    return { id: account.id, address: account.address, syncing: false, needsYou: 0, unread: 0, items: [] };
  }

  private async readAccount(account: PhoneInboxAccountConfig, reader: MailboxReader, now: Date): Promise<PhoneInboxAccount> {
    const { id, address } = account;
    const sinceSeconds = Math.floor(now.getTime() / 1000) - REPLY_LOOKBACK_SECONDS;
    // One call at a time: the provider limits per mailbox, and parallel calls are what trips it.
    const unreadMessages = await reader.unreadInbox();
    const sent = await reader.sentSince(sinceSeconds);

    const lastReplyByThread = new Map<string, number>();
    for (const message of sent) {
      lastReplyByThread.set(message.threadId, Math.max(message.date, lastReplyByThread.get(message.threadId) ?? 0));
    }

    // One entry per thread: the newest tagged, unanswered, unread message.
    const newestByThread = new Map<string, { message: InboxMessage; group: PhoneInboxGroup }>();
    for (const message of unreadMessages) {
      const group = groupOf(message.folderNames);
      if (!group) continue;
      if ((lastReplyByThread.get(message.threadId) ?? 0) >= message.date) continue; // you replied after it arrived
      const current = newestByThread.get(message.threadId);
      if (!current || message.date > current.message.date) newestByThread.set(message.threadId, { message, group });
    }

    const items = [...newestByThread.values()]
      .sort((a, b) => b.message.date - a.message.date)
      .map(({ message, group }): PhoneInboxItem => ({
        from: senderOf(message),
        subject: message.subject,
        group,
        receivedAt: new Date(message.date * 1000).toISOString(),
        threadId: message.threadId,
        // Only Outlook needs a message id; the Gmail link is built from the thread id.
        ...(id === 'work-outlook' ? { messageId: message.id } : {}),
      }));

    return { id, address, syncing: true, needsYou: items.length, unread: unreadMessages.length, items };
  }
}
