import { describe, it, expect } from 'vitest';
import { CleanupError, ImportCleanupService, type CleanupCandidate } from '../../../src/contacts-import/cleanup-service.js';
import { createSilentLogger } from '../../../src/logger.js';

const cand = (n: number): CleanupCandidate => ({ contactId: `c${n}`, displayName: `Person ${n}`, email: `p${n}@kijiji.ca` });

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

  it('works from a scan that stopped part-way, and says which mailboxes are unfinished', async () => {
    const { svc } = make([cand(1)], { running: false, unfinished: ['moonray'] });
    expect(await svc.preview()).toMatchObject({ total: 1, unfinished: ['moonray'] });
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
