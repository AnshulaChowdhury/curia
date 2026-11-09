import { describe, expect, it, vi } from 'vitest';
import { MailboxRateLimitedError } from '../../../src/phone-inbox/phone-inbox-service.js';
import { InboxWatcher, type SeenStore, type TriageSource } from '../../../src/inbox-triage/watcher.js';
import type { PushGroup, TriageCandidate, TriageGroup, TriageVerdict } from '../../../src/inbox-triage/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function candidate(id: string, receivedAt = 1): TriageCandidate {
  return { accountId: 'moonray', messageId: id, threadId: `t-${id}`, from: 'Dana', subject: 'Hi', snippet: '...', receivedAt };
}

function memorySeen(): SeenStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return { keys, has: async (k) => keys.has(k), add: async (k) => { keys.add(k); } };
}

function source(candidates: TriageCandidate[]) {
  const applied: Array<[string, TriageGroup]> = [];
  const s: TriageSource = {
    accountId: 'moonray',
    listUntagged: async () => candidates,
    applyLabel: async (id, group) => { applied.push([id, group]); },
  };
  return { s, applied };
}

const verdict = (group: TriageVerdict['group']): TriageVerdict => ({ group, confidence: 0.9, unsure: false });

describe('InboxWatcher', () => {
  it('labels and pushes for urgent, drafted and seen', async () => {
    const { s, applied } = source([candidate('a', 1), candidate('b', 2), candidate('c', 3)]);
    const groups: TriageVerdict['group'][] = ['urgent', 'drafted', 'seen'];
    const classify = vi.fn(async () => verdict(groups.shift()!));
    const notify = vi.fn(async (_group: TriageGroup) => {});
    await new InboxWatcher({ sources: [s], classifier: { classify }, notifier: { notify }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(applied).toEqual([['a', 'urgent'], ['b', 'drafted'], ['c', 'seen']]);
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['urgent', 'drafted', 'seen']);
  });

  it('labels newsletter and spam mail but never pushes for it', async () => {
    const { s, applied } = source([candidate('a', 1), candidate('b', 2)]);
    const groups: TriageVerdict['group'][] = ['newsletter', 'spam'];
    const classify = vi.fn(async () => verdict(groups.shift()!));
    const notify = vi.fn(async (_group: PushGroup) => {});
    await new InboxWatcher({ sources: [s], classifier: { classify }, notifier: { notify }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(applied).toEqual([['a', 'newsletter'], ['b', 'spam']]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing for none', async () => {
    const { s, applied } = source([candidate('a')]);
    const notify = vi.fn(async () => {});
    await new InboxWatcher({ sources: [s], classifier: { classify: async () => verdict('none') }, notifier: { notify }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(applied).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('never classifies the same message twice, even across watchers sharing a store', async () => {
    const seen = memorySeen();
    const classify = vi.fn(async () => verdict('seen'));
    const make = () => new InboxWatcher({ sources: [source([candidate('a')]).s], classifier: { classify }, notifier: { notify: async () => {} }, seen, logger, intervalMs: 1000 });
    await make().tick();
    await make().tick();
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('skips a message when classification throws, and keeps going', async () => {
    const { s, applied } = source([candidate('a', 1), candidate('b', 2)]);
    const classify = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(verdict('seen'));
    await new InboxWatcher({ sources: [s], classifier: { classify }, notifier: { notify: async () => {} }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(applied).toEqual([['b', 'seen']]);
  });

  it('does not push when the label could not be applied', async () => {
    const s: TriageSource = { accountId: 'moonray', listUntagged: async () => [candidate('a')], applyLabel: async () => { throw new Error('nylas down'); } };
    const notify = vi.fn(async () => {});
    await new InboxWatcher({ sources: [s], classifier: { classify: async () => verdict('urgent') }, notifier: { notify }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the label when the push fails', async () => {
    const { s, applied } = source([candidate('a')]);
    await new InboxWatcher({ sources: [s], classifier: { classify: async () => verdict('urgent') }, notifier: { notify: async () => { throw new Error('ntfy down'); } }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(applied).toEqual([['a', 'urgent']]);
  });

  it('survives a failing mailbox and still serves the others', async () => {
    const bad: TriageSource = { accountId: 'personal', listUntagged: async () => { throw new Error('429'); }, applyLabel: async () => {} };
    const { s, applied } = source([candidate('a')]);
    await new InboxWatcher({ sources: [bad, s], classifier: { classify: async () => verdict('seen') }, notifier: { notify: async () => {} }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(applied).toEqual([['a', 'seen']]);
  });

  it('classifies at most maxPerTick messages per account, oldest first', async () => {
    const { s, applied } = source([candidate('new', 9), candidate('old', 1), candidate('mid', 5)]);
    await new InboxWatcher({ sources: [s], classifier: { classify: async () => verdict('seen') }, notifier: { notify: async () => {} }, seen: memorySeen(), logger, intervalMs: 1000, maxPerTick: 2 }).tick();
    expect(applied.map(([id]) => id)).toEqual(['old', 'mid']);
  });

  it('reports how each message ended: tagged, none, or failed', async () => {
    const { s: src } = source([candidate('a', 1), candidate('b', 2), candidate('c', 3)]);
    const answers: Array<TriageVerdict | Error> = [verdict('seen'), verdict('none'), new Error('model down')];
    const record = vi.fn(async () => {});
    await new InboxWatcher({
      sources: [src], seen: memorySeen(), logger, intervalMs: 1000, notifier: { notify: async () => {} }, outcomes: { record },
      classifier: { classify: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; } },
    }).tick();
    expect((record.mock.calls as unknown as Array<[TriageCandidate, string]>).map(([c, o]) => [c.messageId, o])).toEqual([['a', 'tagged'], ['b', 'none'], ['c', 'failed']]);
  });

  it('reports a label that could not be applied as failed, so it can be sorted by hand', async () => {
    const record = vi.fn(async (_c: TriageCandidate, _o: string) => {});
    const src: TriageSource = { accountId: 'moonray', listUntagged: async () => [candidate('a')], applyLabel: async () => { throw new Error('boom'); } };
    await new InboxWatcher({ sources: [src], seen: memorySeen(), logger, intervalMs: 1000, notifier: { notify: async () => {} }, outcomes: { record }, classifier: { classify: async () => verdict('urgent') } }).tick();
    expect(record.mock.calls[0]![1]).toBe('failed');
  });

  it('a recorder failure never stops the pass', async () => {
    const { s: src, applied } = source([candidate('a', 1), candidate('b', 2)]);
    await new InboxWatcher({ sources: [src], seen: memorySeen(), logger, intervalMs: 1000, notifier: { notify: async () => {} }, outcomes: { record: async () => { throw new Error('db down'); } }, classifier: { classify: async () => verdict('seen') } }).tick();
    expect(applied.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('labels mail the owner already read but does not wake the phone for it', async () => {
    const { s: src, applied } = source([{ ...candidate('a'), unread: false }]);
    const notify = vi.fn(async () => {});
    await new InboxWatcher({ sources: [src], seen: memorySeen(), logger, intervalMs: 1000, notifier: { notify }, classifier: { classify: async () => verdict('urgent') } }).tick();
    expect(applied).toEqual([['a', 'urgent']]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('asks the source to skip mail it has already handled', async () => {
    const seen = memorySeen();
    seen.keys.add('moonray:old');
    let skip: ((id: string) => Promise<boolean>) | undefined;
    const src: TriageSource = { accountId: 'moonray', listUntagged: async (isKnown) => { skip = isKnown; return []; }, applyLabel: async () => {} };
    await new InboxWatcher({ sources: [src], seen, logger, intervalMs: 1000, notifier: { notify: async () => {} }, classifier: { classify: async () => verdict('seen') } }).tick();
    expect(await skip!('old')).toBe(true);
    expect(await skip!('new')).toBe(false);
  });

  it('leaves a rate-limited mailbox alone until its cool-down ends', async () => {
    const list = vi.fn(async (): Promise<TriageCandidate[]> => { throw new MailboxRateLimitedError(60); });
    const src: TriageSource = { accountId: 'moonray', listUntagged: list, applyLabel: async () => {} };
    const watcher = new InboxWatcher({ sources: [src], seen: memorySeen(), logger, intervalMs: 1000, notifier: { notify: async () => {} }, classifier: { classify: async () => verdict('seen') } });
    await watcher.tick();
    await watcher.tick();
    expect(list).toHaveBeenCalledTimes(1);
  });

  describe('beforeClassify', () => {
    it('skips classification and labelling for mail the hook handled, and records it as tagged', async () => {
      const { s, applied } = source([candidate('a', 1), candidate('b', 2)]);
      const classify = vi.fn(async () => verdict('seen'));
      const record = vi.fn(async () => {});
      const beforeClassify = vi.fn(async (c: TriageCandidate) => (c.messageId === 'a' ? ('handled' as const) : ('continue' as const)));
      await new InboxWatcher({
        sources: [s], classifier: { classify }, notifier: { notify: async () => {} }, seen: memorySeen(), outcomes: { record },
        beforeClassify, logger, intervalMs: 1000,
      }).tick();
      expect(classify).toHaveBeenCalledTimes(1);
      expect(applied).toEqual([['b', 'seen']]);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'a' }), 'tagged');
    });

    it('classifies the mail normally when the hook throws', async () => {
      const { s, applied } = source([candidate('a', 1)]);
      const beforeClassify = vi.fn(async () => { throw new Error('db down'); });
      await new InboxWatcher({
        sources: [s], classifier: { classify: async () => verdict('seen') }, notifier: { notify: async () => {} }, seen: memorySeen(),
        beforeClassify, logger, intervalMs: 1000,
      }).tick();
      expect(applied).toEqual([['a', 'seen']]);
    });
  });
});
