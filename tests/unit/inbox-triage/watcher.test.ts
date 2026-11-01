import { describe, expect, it, vi } from 'vitest';
import { InboxWatcher, type SeenStore, type TriageSource } from '../../../src/inbox-triage/watcher.js';
import type { TriageCandidate, TriageGroup, TriageVerdict } from '../../../src/inbox-triage/types.js';

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
    const notify = vi.fn(async () => {});
    await new InboxWatcher({ sources: [s], classifier: { classify }, notifier: { notify }, seen: memorySeen(), logger, intervalMs: 1000 }).tick();
    expect(applied).toEqual([['a', 'urgent'], ['b', 'drafted'], ['c', 'seen']]);
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['urgent', 'drafted', 'seen']);
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
});
