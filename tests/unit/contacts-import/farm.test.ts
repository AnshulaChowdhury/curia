import { describe, it, expect } from 'vitest';
import { reduceMessages, ignoredFolderIds, MAX_RECIPIENTS } from '../../../src/contacts-import/farm-reduce.js';
import { InMemoryFarmStore } from '../../../src/contacts-import/farm-store.js';
import { MailboxFarmService, type FarmTarget } from '../../../src/contacts-import/farm-service.js';
import { farmCollector, resolveFarmTarget } from '../../../src/contacts-import/mailbox-contacts.js';
import { InMemoryMailboxCategoryStore } from '../../../src/phone-inbox/mailbox-category-store.js';
import { MailboxRateLimitedError } from '../../../src/phone-inbox/phone-inbox-service.js';
import type { ScannedMessage, ScanPage } from '../../../src/phone-inbox/nylas-mailbox.js';
import { createSilentLogger } from '../../../src/logger.js';

const ME = 'me@example.com';
const msg = (from: string, to: string[], date: number, extra: Partial<ScannedMessage> = {}, fromName?: string): ScannedMessage => ({
  from: [{ email: from, ...(fromName ? { name: fromName } : {}) }], to: to.map((email) => ({ email })), cc: [], date, folders: [], ...extra,
});

describe('reduceMessages', () => {
  it('counts received, sent and copied; skips own address, automated senders, spam and mailing lists', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@lists.org`);
    const out = reduceMessages([
      msg('Dana@Acme.com', [ME, 'bob@acme.com'], 100, {}, 'Dana Smith'),
      msg('dana@acme.com', [ME], 300),
      msg(ME, ['dana@acme.com', 'erin@acme.com'], 200),
      msg('noreply@shop.com', [ME], 150),
      msg('spammer@x.com', [ME], 160, { folders: ['SPAM'] }),
      msg('host@lists.org', many, 170),
      msg(ME, many, 180),
    ], ME, new Set(['SPAM']));
    const d = out.get('dana@acme.com')!;
    expect(d).toMatchObject({ received: 2, sent: 1, copied: 0, first: 100, last: 300, domain: 'acme.com', name: 'Dana Smith' });
    expect(out.get('bob@acme.com')).toMatchObject({ copied: 1, received: 0 });
    expect(out.get('erin@acme.com')).toMatchObject({ sent: 1 });
    expect(out.has(ME)).toBe(false);
    expect(out.has('noreply@shop.com')).toBe(false);
    expect(out.has('spammer@x.com')).toBe(false);
    expect(out.get('host@lists.org')).toMatchObject({ received: 1 }); // the sender of a list is counted, its recipients are not
    expect(out.has('p0@lists.org')).toBe(false);
  });
  it('finds ignored folders by name or id', () => {
    expect([...ignoredFolderIds(new Map([['a', 'Junk Email'], ['b', 'Inbox'], ['TRASH', 'x']]))].sort()).toEqual(['TRASH', 'a']);
  });
});

function scanner(pages: (ScanPage | Error)[]) {
  let i = 0;
  const cursors: (string | undefined)[] = [];
  return {
    cursors,
    mailbox: {
      folderNames: async () => new Map<string, string>(),
      scanPage: async (_after: number, cursor?: string): Promise<ScanPage> => {
        cursors.push(cursor);
        const p = pages[i++]!;
        if (p instanceof Error) throw p;
        return p;
      },
    },
  };
}

describe('MailboxFarmService', () => {
  const mk = (store = new InMemoryFarmStore()) => ({ store, svc: new MailboxFarmService(store, createSilentLogger(), () => Date.UTC(2026, 10, 2), async () => undefined) });
  const target = (mailbox: FarmTarget['mailbox']): FarmTarget => ({ accountId: 'moonray', address: ME, mailbox });

  it('scans every page, accumulates counts and finishes', async () => {
    const { store, svc } = mk();
    const s = scanner([
      { messages: [msg('a@x.com', [ME], 10)], nextCursor: 'c1' },
      { messages: [msg('a@x.com', [ME], 20)] },
    ]);
    const run = await store.startRun('moonray', new Date(0), false);
    await svc.loop(target(s.mailbox), run);
    expect(s.cursors).toEqual([undefined, 'c1']);
    expect((await store.getRun('moonray'))).toMatchObject({ status: 'done', messagesScanned: 2, pagesScanned: 2 });
    expect((await store.facts('moonray', 10))[0]).toMatchObject({ email: 'a@x.com', received: 2 });
  });

  it('waits out a rate limit and carries on', async () => {
    const { store, svc } = mk();
    const s = scanner([new MailboxRateLimitedError(1), { messages: [msg('a@x.com', [ME], 10)] }]);
    await svc.loop(target(s.mailbox), await store.startRun('moonray', new Date(0), false));
    expect((await store.getRun('moonray'))!.status).toBe('done');
  });

  it('waits out a rate limit on the folder list, and pauses (never stays "running") when it keeps failing', async () => {
    const { store, svc } = mk();
    let calls = 0;
    const flaky = { folderNames: async () => { if (calls++ < 2) throw new MailboxRateLimitedError(1); return new Map<string, string>(); }, scanPage: async (): Promise<ScanPage> => ({ messages: [msg('a@x.com', [ME], 10)] }) };
    await svc.loop(target(flaky), await store.startRun('moonray', new Date(0), false));
    expect((await store.getRun('moonray'))!.status).toBe('done');

    const dead = { folderNames: async (): Promise<Map<string, string>> => { throw new MailboxRateLimitedError(1); }, scanPage: async (): Promise<ScanPage> => ({ messages: [] }) };
    await svc.loop(target(dead), await store.startRun('moonray', new Date(0), false));
    expect(await store.getRun('moonray')).toMatchObject({ status: 'paused', errorKind: 'rate_limited' });
  });

  it('a failure stops the scan and a resume continues from the saved cursor without double counting', async () => {
    const { store, svc } = mk();
    const s1 = scanner([{ messages: [msg('a@x.com', [ME], 10)], nextCursor: 'c1' }, new Error('boom')]);
    await svc.loop(target(s1.mailbox), await store.startRun('moonray', new Date(0), false));
    expect(await store.getRun('moonray')).toMatchObject({ status: 'failed', cursor: 'c1', errorKind: 'Error' });

    const s2 = scanner([{ messages: [msg('b@x.com', [ME], 20)] }]);
    await svc.loop(target(s2.mailbox), await store.startRun('moonray', new Date(0), true));
    expect(s2.cursors).toEqual(['c1']);
    const facts = await store.facts('moonray', 10);
    expect(facts.map((f) => [f.email, f.received]).sort()).toEqual([['a@x.com', 1], ['b@x.com', 1]]);
  });

  it('scanning again never deletes: it adds mail since the last scan to the existing counts', async () => {
    const { store, svc } = mk();
    await svc.loop(target(scanner([{ messages: [msg('a@x.com', [ME], 10)] }]).mailbox), await store.startRun('moonray', new Date(0), false));
    const first = (await store.getRun('moonray'))!;
    const again = await store.startRun('moonray', new Date(0), false);
    expect(await store.countFacts('moonray')).toBe(1);
    expect(again).toMatchObject({ status: 'running', cursor: null, windowStart: first.startedAt, messagesScanned: 1 });
    await svc.loop(target(scanner([{ messages: [msg('a@x.com', [ME], 30)] }]).mailbox), again);
    expect((await store.facts('moonray', 10))[0]).toMatchObject({ received: 2 });
  });

  it('starting while a scan is unfinished resumes it, whatever was asked', async () => {
    const { store, svc } = mk();
    await svc.loop(target(scanner([{ messages: [msg('a@x.com', [ME], 10)], nextCursor: 'c1' }, new Error('boom')]).mailbox), await store.startRun('moonray', new Date(0), false));
    expect(await store.startRun('moonray', new Date(0), false)).toMatchObject({ status: 'running', cursor: 'c1' });
    expect(await store.countFacts('moonray')).toBe(1);
  });

  it('refuses a second scan of the same mailbox while one runs', async () => {
    const { store, svc } = mk();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const box = { folderNames: async () => { await gate; return new Map<string, string>(); }, scanPage: async (): Promise<ScanPage> => ({ messages: [] }) };
    await svc.start(target(box), { resume: false });
    await expect(svc.start(target(box), { resume: false })).rejects.toThrow('already_running');
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.isRunning('moonray')).toBe(false);
    expect((await store.getRun('moonray'))!.status).toBe('done');
  });
});

describe('mailbox eligibility and candidates', () => {
  it('needs a connected Nylas grant and a reported category; skips Work Outlook', async () => {
    const cats = new InMemoryMailboxCategoryStore();
    expect(await resolveFarmTarget('nope', [], cats)).toEqual({ ok: false, reason: 'unknown_account' });
    expect(await resolveFarmTarget('work-outlook', [], cats)).toEqual({ ok: false, reason: 'skipped' });
    expect(await resolveFarmTarget('moonray', [{ id: 'moonray', address: null, reader: null }], cats)).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('turns person facts into labelled candidates and leaves role addresses out', async () => {
    const store = new InMemoryFarmStore();
    await store.startRun('moonray', new Date(0), false);
    await store.commitPage('moonray', null, 3, [
      { email: 'dana@acme.com', domain: 'acme.com', name: 'Dana Smith', received: 2, sent: 1, copied: 0, first: 10, last: 20 },
      { email: 'info@acme.com', domain: 'acme.com', received: 1, sent: 0, copied: 0, first: 10, last: 20 },
    ]);
    await store.finish('moonray', 'done');
    const r = await farmCollector('moonray', 'Moonray', 'WORK', store).collect();
    expect(r.ok).toBe(true);
    expect(r.candidates).toEqual([{ sourceKey: 'mailbox:moonray:dana@acme.com', sourceId: 'mailbox:moonray', displayName: 'Dana Smith', emails: ['dana@acme.com'], phones: [], label: 'work' }]);
  });

  it('says so when the mailbox was never scanned', async () => {
    const r = await farmCollector('moonray', 'Moonray', 'WORK', new InMemoryFarmStore()).collect();
    expect(r.ok).toBe(false);
  });
});
