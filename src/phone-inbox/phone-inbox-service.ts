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
  ) {}

  /**
   * Builds the current answer. Throws [PhoneInboxUnavailableError] if any configured mailbox can't be
   * read: showing "0 need you" for a mailbox we failed to read would be wrong, and the phone keeps its
   * cached list on a server error.
   */
  async build(): Promise<PhoneInbox> {
    const now = this.now();
    const accounts = await Promise.all(this.accounts.map((account) => this.buildAccount(account, now)));
    return { updatedAt: now.toISOString(), accounts };
  }

  private async buildAccount(account: PhoneInboxAccountConfig, now: Date): Promise<PhoneInboxAccount> {
    const { id, address, reader } = account;
    if (!reader) return { id, address, needsYou: 0, unread: 0, items: [] };

    const sinceSeconds = Math.floor(now.getTime() / 1000) - REPLY_LOOKBACK_SECONDS;
    let unreadMessages: InboxMessage[];
    let sent: SentMessage[];
    try {
      [unreadMessages, sent] = await Promise.all([reader.unreadInbox(), reader.sentSince(sinceSeconds)]);
    } catch (err) {
      // Log the failure without any message content; the caller turns this into a 5xx.
      this.logger.error({ err, account: id }, 'phone-inbox: mailbox read failed');
      throw new PhoneInboxUnavailableError(id, err);
    }

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

    return { id, address, needsYou: items.length, unread: unreadMessages.length, items };
  }
}
