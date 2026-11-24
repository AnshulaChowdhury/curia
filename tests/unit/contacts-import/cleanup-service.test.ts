import { describe, it, expect } from 'vitest';
import { CleanupError, ImportCleanupService, looksAutomated, type CleanupCandidate } from '../../../src/contacts-import/cleanup-service.js';
import { createSilentLogger } from '../../../src/logger.js';

const cand = (n: number): CleanupCandidate => ({ contactId: `c${n}`, displayName: `Person ${n}`, email: `p${n}@kijiji.ca`, accounts: ['acct'] });

function make(found: CleanupCandidate[], state: { running: boolean; unfinished: string[] } = { running: false, unfinished: [] }, fail: string[] = []) {
  const deleted: string[] = [];
  const svc = new ImportCleanupService(
    { findOneWayImports: async () => found },
    { deleteContact: async (id) => { if (fail.includes(id)) throw new Error('fk'); deleted.push(id); } },
    async () => state,
    createSilentLogger(),
  );
  return { svc, deleted };
}

describe('ImportCleanupService', () => {
  it('previews a count and a masked sample, deleting nothing', async () => {
    const { svc, deleted } = make([cand(1), cand(2)]);
    const p = await svc.preview();
    expect(p.total).toBe(2);
    expect(p.sample[0]).toEqual({ name: 'Person 1', identifier: 'p***@kijiji.ca' });
    expect(deleted).toEqual([]);
  });

  it('holds back person-looking contacts while a mailbox they came from is unfinished', async () => {
    const { svc, deleted } = make([cand(1), { ...cand(2), accounts: ['other'] }], { running: false, unfinished: ['acct'] });
    expect(await svc.preview()).toMatchObject({ total: 1, held: 1, unfinished: ['acct'] });
    await svc.apply(1);
    expect(deleted).toEqual(['c2']);
  });

  it('still removes plainly automated senders from an unfinished mailbox', async () => {
    const bot = { contactId: 'bot', displayName: 'Longos', email: 'noreply@longos.com', accounts: ['acct'] };
    const sub = { contactId: 'sub', displayName: 'Eng', email: 'eng@substack.com', accounts: ['acct'] };
    const { svc } = make([bot, sub, cand(1)], { running: false, unfinished: ['acct'] });
    expect(await svc.preview()).toMatchObject({ total: 2, held: 1 });
  });

  it('never proves a contact with no known mailbox', async () => {
    const { svc } = make([{ ...cand(1), accounts: [] }]);
    expect(await svc.preview()).toMatchObject({ total: 0, held: 1 });
  });

  it('looksAutomated flags bulk senders but not people', () => {
    for (const e of ['noreply@x.com', 'news@x.com', 'hello@shop.ca', 'a@mail.longos.com', 'x@substack.com']) expect(looksAutomated(e)).toBe(true);
    for (const e of ['aly@alyvergara.studio', 'ashneet.kaur@centennialcollege.ca', 'newsom@x.com', 'teamster@x.com', 'bob@gmail.com']) expect(looksAutomated(e)).toBe(false);
  });

  it('refuses to preview or apply while a scan is actively running', async () => {
    const { svc, deleted } = make([cand(1)], { running: true, unfinished: [] });
    await expect(svc.preview()).rejects.toMatchObject({ code: 'scans_running' });
    await expect(svc.apply(1)).rejects.toBeInstanceOf(CleanupError);
    expect(deleted).toEqual([]);
  });

  it('refuses when the count is not the one that was reviewed', async () => {
    const { svc, deleted } = make([cand(1), cand(2)]);
    await expect(svc.apply(1)).rejects.toMatchObject({ code: 'count_changed' });
    expect(deleted).toEqual([]);
  });

  it('removes the reviewed contacts and keeps one that is still referenced', async () => {
    const { svc, deleted } = make([cand(1), cand(2), cand(3)], { running: false, unfinished: [] }, ['c2']);
    expect(await svc.apply(3)).toEqual({ removed: 2, kept: 1 });
    expect(deleted).toEqual(['c1', 'c3']);
  });
});
