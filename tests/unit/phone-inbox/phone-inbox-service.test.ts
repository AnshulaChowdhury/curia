import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '../../../src/logger.js';
import {
  MailboxRateLimitedError,
  PhoneInboxCache,
  PhoneInboxService,
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

  describe('when a mailbox cannot be read, and caching', () => {
    function counting(unread: InboxMessage[]) {
      let calls = 0;
      let failWith: Error | null = null;
      const r: MailboxReader = {
        unreadInbox: async () => { calls++; if (failWith) throw failWith; return unread; },
        sentSince: async () => [],
      };
      return { r, calls: () => calls, fail: (e: Error | null) => { failWith = e; } };
    }
    const at = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000);
    const make = (accounts: Array<[string, MailboxReader | null]>, cache: PhoneInboxCache, clock: { t: Date }) =>
      new PhoneInboxService(
        accounts.map(([id, r]) => ({ id: id as 'personal', address: `${id}@example.com`, reader: r })),
        logger,
        () => clock.t,
        cache,
      );

    it('serves a recent answer from memory instead of asking the provider again', async () => {
      const m = counting([message({ id: 'a' })]);
      const clock = { t: NOW };
      const svc = make([['personal', m.r]], new PhoneInboxCache(), clock);
      await svc.build();
      clock.t = at(30);
      await svc.build();
      expect(m.calls()).toBe(1);
      clock.t = at(61);
      await svc.build();
      expect(m.calls()).toBe(2);
    });

    it('keeps serving the last good answer when a later read fails', async () => {
      const m = counting([message({ id: 'a', subject: 'Keep me' })]);
      const clock = { t: NOW };
      const svc = make([['personal', m.r]], new PhoneInboxCache(), clock);
      await svc.build();
      m.fail(new Error('boom'));
      clock.t = at(120);
      const result = await svc.build();
      expect(result.accounts[0]!.syncing).toBe(true);
      expect(result.accounts[0]!.items.map((i) => i.subject)).toEqual(['Keep me']);
    });

    it('says not syncing, not "all clear", once the last good answer is too old or there never was one', async () => {
      const m = counting([message({ id: 'a' })]);
      m.fail(new Error('boom'));
      const clock = { t: NOW };
      const svc = make([['personal', m.r]], new PhoneInboxCache(), clock);
      expect((await svc.build()).accounts[0]).toMatchObject({ syncing: false, needsYou: 0, items: [] });

      m.fail(null);
      clock.t = at(10);
      await svc.build(); // good answer cached at t=10
      m.fail(new Error('boom'));
      clock.t = at(10 + 31 * 60);
      expect((await svc.build()).accounts[0]!.syncing).toBe(false);
    });

    it('one failing mailbox does not stop the others', async () => {
      const bad = counting([]);
      bad.fail(new Error('boom'));
      const good = counting([message({ id: 'g' })]);
      const result = await make([['personal', bad.r], ['moonray', good.r]], new PhoneInboxCache(), { t: NOW }).build();
      expect(result.accounts.map((a) => [a.id, a.syncing, a.needsYou])).toEqual([['personal', false, 0], ['moonray', true, 1]]);
    });

    it('leaves a rate-limited mailbox alone until its cool-down ends', async () => {
      const m = counting([message({ id: 'a' })]);
      m.fail(new MailboxRateLimitedError(120));
      const clock = { t: NOW };
      const svc = make([['personal', m.r]], new PhoneInboxCache(), clock);
      await svc.build();
      expect(m.calls()).toBe(1);
      clock.t = at(100); // inside Retry-After (120s)
      await svc.build();
      expect(m.calls()).toBe(1);
      m.fail(null);
      clock.t = at(121);
      const result = await svc.build();
      expect(m.calls()).toBe(2);
      expect(result.accounts[0]!.syncing).toBe(true);
    });

    it('asks the provider one call at a time within a mailbox', async () => {
      let running = 0;
      let peak = 0;
      const slow = async <T,>(v: T): Promise<T> => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return v; };
      const r: MailboxReader = { unreadInbox: () => slow([message({ id: 'a' })]), sentSince: () => slow([] as SentMessage[]) };
      await make([['personal', r]], new PhoneInboxCache(), { t: NOW }).build();
      expect(peak).toBe(1);
    });
  });
});
