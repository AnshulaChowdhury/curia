import { describe, expect, it, vi } from 'vitest';
import { GRACE_DAYS, RETRY_SPACING_DAYS, UnsubscribeEnforcer, decide, type EnforcerSource } from '../../../src/inbox-triage/unsubscribe-enforcer.js';
import type { UnsubscribeRecord } from '../../../src/inbox-triage/unsubscribe-store.js';
import type { TriageCandidate } from '../../../src/inbox-triage/types.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const at = (days: number) => new Date(T0 + days * DAY);
const record = (over: Partial<UnsubscribeRecord> = {}): UnsubscribeRecord => ({ unsubscribedAt: at(0), attempts: 0, lastAttemptAt: null, trashedAt: null, ...over });

describe('decide', () => {
  it('waits out the grace period after the unsubscribe', () => {
    expect(decide(record(), T0 + (GRACE_DAYS - 0.01) * DAY)).toBe('wait');
    expect(decide(record(), T0 + GRACE_DAYS * DAY)).toBe('retry');
  });
  it('waits between retries, then retries until three have been made', () => {
    const second = record({ attempts: 1, lastAttemptAt: at(10) });
    expect(decide(second, T0 + (10 + RETRY_SPACING_DAYS - 0.01) * DAY)).toBe('wait');
    expect(decide(second, T0 + (10 + RETRY_SPACING_DAYS) * DAY)).toBe('retry');
    expect(decide(record({ attempts: 2, lastAttemptAt: at(14) }), T0 + 30 * DAY)).toBe('retry');
  });
  it('trashes once three retries were made and the sender still mails (after the spacing)', () => {
    const third = record({ attempts: 3, lastAttemptAt: at(20) });
    expect(decide(third, T0 + 21 * DAY)).toBe('wait');
    expect(decide(third, T0 + 23 * DAY)).toBe('trash');
  });
  it('trashes immediately once the sender has been trashed before', () => {
    expect(decide(record({ attempts: 3, lastAttemptAt: at(20), trashedAt: at(23) }), T0 + 23.1 * DAY)).toBe('trash');
  });
});

const cand = (over: Partial<TriageCandidate> = {}): TriageCandidate =>
  ({ accountId: 'moonray', messageId: 'm1', threadId: 't', from: 'News', fromAddress: 'News@Sender.com', subject: 's', snippet: '', receivedAt: 1, ...over });

function make(rec: UnsubscribeRecord | null, opts: { now?: number; countOk?: boolean; headers?: { listUnsubscribe: string | null; listUnsubscribePost: string | null; fromAddress: string | null } | null; trashFails?: boolean; labelFails?: boolean } = {}) {
  const store = {
    get: vi.fn(async () => rec),
    countAttempt: vi.fn(async () => opts.countOk ?? true),
    markTrashed: vi.fn(async () => {}),
  };
  const preferences = { save: vi.fn(async () => {}) };
  const readHeaders = vi.fn(async () => (opts.headers === undefined
    ? { listUnsubscribe: '<https://news.sender.com/u?t=1>', listUnsubscribePost: 'List-Unsubscribe=One-Click', fromAddress: 'news@sender.com' }
    : opts.headers));
  const oneClick = vi.fn(async () => ({ ok: true as const, status: 200 }));
  const source: EnforcerSource & { applyLabel: ReturnType<typeof vi.fn>; moveToTrash: ReturnType<typeof vi.fn> } = {
    applyLabel: vi.fn(async () => { if (opts.labelFails) throw new Error('label'); }),
    moveToTrash: vi.fn(async () => { if (opts.trashFails) throw new Error('trash'); }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const enforcer = new UnsubscribeEnforcer({ logger, store, preferences, readHeaders, oneClick, now: () => opts.now ?? T0 });
  return { enforcer, store, preferences, readHeaders, oneClick, source };
}

describe('UnsubscribeEnforcer.check', () => {
  it('does nothing for a sender that was never unsubscribed, or mail with no address', async () => {
    const none = make(null);
    expect(await none.enforcer.check(cand(), none.source)).toBe('continue');
    expect(none.store.get).toHaveBeenCalledWith('moonray', 'news@sender.com');
    const noAddress = make(record());
    expect(await noAddress.enforcer.check(cand({ fromAddress: undefined }), noAddress.source)).toBe('continue');
    expect(noAddress.store.get).not.toHaveBeenCalled();
  });

  it('leaves mail alone during the grace period', async () => {
    const m = make(record(), { now: T0 + 5 * DAY });
    expect(await m.enforcer.check(cand(), m.source)).toBe('continue');
    expect(m.oneClick).not.toHaveBeenCalled();
    expect(m.source.moveToTrash).not.toHaveBeenCalled();
  });

  it('repeats the one-click request from the new email, counts it first, and still classifies the mail', async () => {
    const m = make(record(), { now: T0 + 11 * DAY });
    expect(await m.enforcer.check(cand(), m.source)).toBe('continue');
    expect(m.store.countAttempt).toHaveBeenCalledWith('moonray', 'news@sender.com', 0);
    expect(m.readHeaders).toHaveBeenCalledWith('moonray', 'm1');
    expect((m.oneClick.mock.calls[0] as unknown as [URL])[0].href).toBe('https://news.sender.com/u?t=1');
    expect(m.source.moveToTrash).not.toHaveBeenCalled();
  });

  it('does not retry when another pass already counted this try', async () => {
    const m = make(record(), { now: T0 + 11 * DAY, countOk: false });
    await m.enforcer.check(cand(), m.source);
    expect(m.oneClick).not.toHaveBeenCalled();
  });

  it('counts the try but sends nothing when the new email has no safe one-click link', async () => {
    for (const headers of [null, { listUnsubscribe: '<https://news.sender.com/u>', listUnsubscribePost: null, fromAddress: null }, { listUnsubscribe: '<https://169.254.169.254/x>', listUnsubscribePost: 'List-Unsubscribe=One-Click', fromAddress: null }]) {
      const m = make(record(), { now: T0 + 11 * DAY, headers });
      expect(await m.enforcer.check(cand(), m.source)).toBe('continue');
      expect(m.store.countAttempt).toHaveBeenCalled();
      expect(m.oneClick).not.toHaveBeenCalled();
    }
  });

  it('after three failed retries: labels spam, moves to Trash, remembers it, saves the sender as spam, skips classification', async () => {
    const m = make(record({ attempts: 3, lastAttemptAt: at(20) }), { now: T0 + 24 * DAY });
    expect(await m.enforcer.check(cand(), m.source)).toBe('handled');
    expect(m.source.applyLabel).toHaveBeenCalledWith('m1', 'spam');
    expect(m.source.moveToTrash).toHaveBeenCalledWith('m1');
    expect(m.store.markTrashed).toHaveBeenCalledWith('moonray', 'news@sender.com');
    expect(m.preferences.save).toHaveBeenCalledWith({ accountId: 'moonray', scope: 'sender', value: 'news@sender.com', group: 'spam' });
    expect(m.oneClick).not.toHaveBeenCalled();
  });

  it('trashes at once for a sender already trashed before', async () => {
    const m = make(record({ attempts: 3, lastAttemptAt: at(20), trashedAt: at(24) }), { now: T0 + 25 * DAY });
    expect(await m.enforcer.check(cand(), m.source)).toBe('handled');
    expect(m.source.moveToTrash).toHaveBeenCalled();
  });

  it('if the label cannot be written, classifies normally; if only Trash fails, the mail is still handled and not marked trashed', async () => {
    const label = make(record({ attempts: 3, lastAttemptAt: at(20) }), { now: T0 + 24 * DAY, labelFails: true });
    expect(await label.enforcer.check(cand(), label.source)).toBe('continue');
    expect(label.source.moveToTrash).not.toHaveBeenCalled();
    const trash = make(record({ attempts: 3, lastAttemptAt: at(20) }), { now: T0 + 24 * DAY, trashFails: true });
    expect(await trash.enforcer.check(cand(), trash.source)).toBe('handled');
    expect(trash.store.markTrashed).not.toHaveBeenCalled();
    expect(trash.preferences.save).not.toHaveBeenCalled();
  });

  it('a mailbox that cannot trash is never asked to', async () => {
    const m = make(record({ attempts: 3, lastAttemptAt: at(20) }), { now: T0 + 24 * DAY });
    const noTrash: EnforcerSource = { applyLabel: m.source.applyLabel };
    expect(await m.enforcer.check(cand(), noTrash)).toBe('continue');
    expect(m.source.applyLabel).not.toHaveBeenCalled();
  });
});
