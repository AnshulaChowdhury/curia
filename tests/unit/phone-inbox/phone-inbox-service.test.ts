import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '../../../src/logger.js';
import {
  PhoneInboxService,
  PhoneInboxUnavailableError,
  groupOfLabel,
  type InboxMessage,
  type MailboxReader,
  type SentMessage,
} from '../../../src/phone-inbox/phone-inbox-service.js';

const NOW = new Date('2026-11-01T12:00:00Z');
const nowSec = NOW.getTime() / 1000;
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

function message(over: Partial<InboxMessage> & { id: string }): InboxMessage {
  return {
    threadId: `t-${over.id}`,
    subject: 'Subject',
    fromName: 'Dana Whitfield',
    fromEmail: 'dana@example.com',
    date: nowSec - 3600,
    folderNames: ['INBOX', '🚨 Urgent'],
    ...over,
  };
}

function reader(unread: InboxMessage[], sent: SentMessage[] = []): MailboxReader {
  return { unreadInbox: async () => unread, sentSince: async () => sent };
}

async function build(accounts: Array<[string, MailboxReader | null]>) {
  const service = new PhoneInboxService(
    accounts.map(([id, r]) => ({ id: id as 'personal', address: `${id}@example.com`, reader: r })),
    logger,
    () => NOW,
  );
  return service.build();
}

describe('groupOfLabel', () => {
  it('ignores emoji and case', () => {
    expect(groupOfLabel('🚨 Urgent')).toBe('urgent');
    expect(groupOfLabel('✍️ Drafted')).toBe('drafted');
    expect(groupOfLabel('📌 Seen')).toBe('seen');
    expect(groupOfLabel('✅ Handled')).toBeNull();
    expect(groupOfLabel('INBOX')).toBeNull();
  });
});

describe('PhoneInboxService', () => {
  it('lists tagged unread mail newest first and counts it', async () => {
    const result = await build([
      ['moonray', reader([
        message({ id: 'a', date: nowSec - 7200, folderNames: ['📌 Seen'], subject: 'Older' }),
        message({ id: 'b', date: nowSec - 60, subject: 'Newer' }),
        message({ id: 'c', folderNames: ['INBOX'] }), // untagged: unread but doesn't need you
      ])],
    ]);
    const account = result.accounts[0]!;
    expect(account.items.map((i) => i.subject)).toEqual(['Newer', 'Older']);
    expect(account.items.map((i) => i.group)).toEqual(['urgent', 'seen']);
    expect(account.syncing).toBe(true);
    expect(account.needsYou).toBe(2);
    expect(account.unread).toBe(3);
    expect(result.updatedAt).toBe('2026-11-01T12:00:00.000Z');
  });

  it('drops a thread once you replied after it arrived, but not a reply that came before', async () => {
    const result = await build([
      ['personal', reader(
        [
          message({ id: 'a', threadId: 'answered', date: nowSec - 3600 }),
          message({ id: 'b', threadId: 'newer-than-reply', date: nowSec - 600 }),
        ],
        [
          { threadId: 'answered', date: nowSec - 1800 },
          { threadId: 'newer-than-reply', date: nowSec - 1800 },
        ],
      )],
    ]);
    expect(result.accounts[0]!.items.map((i) => i.threadId)).toEqual(['newer-than-reply']);
  });

  it('keeps one entry per thread, the newest', async () => {
    const result = await build([
      ['personal', reader([
        message({ id: 'a', threadId: 't', date: nowSec - 3600, subject: 'first' }),
        message({ id: 'b', threadId: 't', date: nowSec - 60, subject: 'second' }),
      ])],
    ]);
    expect(result.accounts[0]!.items.map((i) => i.subject)).toEqual(['second']);
  });

  it('picks urgent over drafted over seen when a message has several labels', async () => {
    const result = await build([
      ['personal', reader([message({ id: 'a', folderNames: ['📌 Seen', '✍️ Drafted'] })])],
    ]);
    expect(result.accounts[0]!.items[0]!.group).toBe('drafted');
  });

  it('falls back to the address when the sender has no name, and returns only Outlook message ids', async () => {
    const result = await build([
      ['personal', reader([message({ id: 'a', fromName: undefined, fromEmail: 'x@example.com' })])],
      ['work-outlook', reader([message({ id: 'AAMk' })])],
    ]);
    expect(result.accounts[0]!.items[0]!.from).toBe('x@example.com');
    expect(result.accounts[0]!.items[0]).not.toHaveProperty('messageId');
    expect(result.accounts[1]!.items[0]!.messageId).toBe('AAMk');
  });

  it('lists an account with no grant as empty', async () => {
    const result = await build([['work-outlook', null]]);
    expect(result.accounts[0]).toEqual({ id: 'work-outlook', address: 'work-outlook@example.com', syncing: false, needsYou: 0, unread: 0, items: [] });
  });

  it('reports a mailbox that is not connected as not syncing, and does not call it syncing when it is', async () => {
    const result = await build([
      ['moonray', reader([])],
      ['work-outlook', null],
    ]);
    expect(result.accounts.map((a) => [a.id, a.syncing])).toEqual([['moonray', true], ['work-outlook', false]]);
  });

  it('never exposes anything beyond the contract fields', async () => {
    const result = await build([['personal', reader([message({ id: 'a' })])]]);
    expect(Object.keys(result.accounts[0]!.items[0]!).sort()).toEqual(['from', 'group', 'receivedAt', 'subject', 'threadId']);
  });

  it('fails the whole answer if a mailbox cannot be read', async () => {
    const broken: MailboxReader = { unreadInbox: async () => { throw new Error('boom'); }, sentSince: async () => [] };
    await expect(build([['personal', broken]])).rejects.toBeInstanceOf(PhoneInboxUnavailableError);
  });
});
