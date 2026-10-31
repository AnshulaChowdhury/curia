// Integration: agenda document lifecycle against real Postgres (#2322).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AgendaStore } from '../../src/meetings/agenda-store.js';
import type { AgendaHistoryEntry } from '../../src/meetings/types.js';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-10-28T16:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function input(overrides: Partial<{
  title: string;
  topics: string[];
  context: string;
  source: 'principal';
  sensitivity: 'internal';
  expiresAt: Date;
  scheduledFor: Date | null;
  role: string | null;
}> = {}) {
  return {
    title: 'Q3 review',
    topics: ['Pipeline', 'Hiring'],
    context: 'Board wants a status.',
    source: 'principal' as const,
    sensitivity: 'internal' as const,
    expiresAt: new Date(NOW.getTime() + 7 * DAY),
    scheduledFor: null as Date | null,
    role: 'Be brief.',
    ...overrides,
  };
}

describeIf('AgendaStore (integration)', () => {
  let isolated: IsolatedWorkingDocsStore;
  let repo: WorkingDocsRepo;
  let store: AgendaStore;

  beforeAll(async () => {
    isolated = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    repo = new WorkingDocsRepo(isolated.pool, createSilentLogger());
    store = new AgendaStore(repo, createSilentLogger());
  });

  afterAll(async () => {
    await isolated?.drop();
  });

  it('park then get round-trips every field', async () => {
    const scheduled = new Date('2026-10-29T15:00:00.000Z');
    const parked = await store.park(input({ scheduledFor: scheduled }), NOW);
    const loaded = await store.get(parked.agendaId);
    expect(loaded).not.toBeNull();
    expect(loaded).toMatchObject({
      agendaId: parked.agendaId,
      title: 'Q3 review',
      topics: ['Pipeline', 'Hiring'],
      role: 'Be brief.',
      context: 'Board wants a status.',
      source: 'principal',
      sensitivity: 'internal',
      status: 'pending',
      scheduledFor: scheduled.toISOString(),
      inCallSession: null,
      history: [],
      path: `/meetings/agendas/${parked.agendaId}.md`,
    });
    expect(loaded?.expiresAt).toBe(input().expiresAt.toISOString());
  });

  it('listPending excludes expired, in_call and done agendas', async () => {
    const pending = await store.park(input({ title: 'Pending' }), NOW);
    const expired = await store.park(input({ title: 'Expired', expiresAt: new Date(NOW.getTime() - DAY) }), NOW);
    const held = await store.park(input({ title: 'Held' }), NOW);
    const finished = await store.park(input({ title: 'Finished' }), NOW);
    await store.lock(held.agendaId, 'session-held', NOW);
    await store.lock(finished.agendaId, 'session-done', NOW);
    await store.settle(finished.agendaId, 'session-done', { kind: 'done' });

    const listed = await store.listPending(NOW);
    const ids = listed.map((doc) => doc.agendaId);
    expect(ids).toContain(pending.agendaId);
    expect(ids).not.toContain(expired.agendaId);
    expect(ids).not.toContain(held.agendaId);
    expect(ids).not.toContain(finished.agendaId);
  });

  it('cullExpired archives only expired pending agendas', async () => {
    const expiredPending = await store.park(input({
      title: 'Stale',
      expiresAt: new Date(NOW.getTime() - 1000),
    }), NOW);
    const expiredHeld = await store.park(input({
      title: 'Still on a call',
      expiresAt: new Date(NOW.getTime() + DAY),
    }), NOW);
    await store.lock(expiredHeld.agendaId, 'session-live', NOW);
    await repo.update(expiredHeld.path, {
      expectedVersion: (await store.get(expiredHeld.agendaId))!.version,
      frontmatter: {
        ...(await repo.read(expiredHeld.path))!.frontmatter,
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      },
    });

    const archived = await store.cullExpired(NOW);
    expect(archived).toBeGreaterThanOrEqual(1);
    expect(await store.get(expiredPending.agendaId)).toBeNull();
    const held = await store.get(expiredHeld.agendaId);
    expect(held?.status).toBe('in_call');
  });

  it('lock is exclusive', async () => {
    const agenda = await store.park(input({ title: 'Exclusive' }), NOW);
    const [first, second] = await Promise.all([
      store.lock(agenda.agendaId, 'session-a', NOW),
      store.lock(agenda.agendaId, 'session-b', NOW),
    ]);
    const winners = [first, second].filter((result) => result.ok);
    expect(winners).toHaveLength(1);
  });

  it('lock rejects an expired agenda with reason expired', async () => {
    const agenda = await store.park(input({
      title: 'Already expired',
      expiresAt: new Date(NOW.getTime() - 1000),
    }), NOW);
    const result = await store.lock(agenda.agendaId, 'session-x', NOW);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('settle done archives the agenda', async () => {
    const agenda = await store.park(input({ title: 'Complete' }), NOW);
    await store.lock(agenda.agendaId, 'session-complete', NOW);
    expect(await store.settle(agenda.agendaId, 'session-complete', { kind: 'done' })).toBe('settled');
    expect(await repo.read(agenda.path)).toBeNull();
  });

  it('settle return restores pending and appends history', async () => {
    const agenda = await store.park(input({ title: 'Partial' }), NOW);
    await store.lock(agenda.agendaId, 'session-partial', NOW);
    const history: AgendaHistoryEntry = {
      sessionId: 'session-partial',
      date: NOW.toISOString(),
      topics: [{ topic: 'Pipeline', coverage: 'partial' }, { topic: 'Hiring', coverage: 'not_reached' }],
    };
    expect(await store.settle(agenda.agendaId, 'session-partial', { kind: 'return', history })).toBe('settled');
    const restored = await store.get(agenda.agendaId);
    expect(restored?.status).toBe('pending');
    expect(restored?.inCallSession).toBeNull();
    expect(restored?.history).toEqual([history]);
  });

  it('settle by a different session returns not_held and changes nothing', async () => {
    const agenda = await store.park(input({ title: 'Held by other' }), NOW);
    await store.lock(agenda.agendaId, 'session-owner', NOW);
    const before = await store.get(agenda.agendaId);
    expect(await store.settle(agenda.agendaId, 'session-other', { kind: 'return' })).toBe('not_held');
    const after = await store.get(agenda.agendaId);
    expect(after?.status).toBe('in_call');
    expect(after?.version).toBe(before?.version);
    expect(after?.inCallSession).toBe('session-owner');
  });

  it('settle retries after a version conflict', async () => {
    const agenda = await store.park(input({ title: 'Edited mid-call' }), NOW);
    await store.lock(agenda.agendaId, 'session-edit', NOW);
    let bumped = false;
    const update = repo.update.bind(repo);
    const spy = vi.spyOn(repo, 'update').mockImplementation(async (path, params) => {
      if (!bumped && path === agenda.path) {
        bumped = true;
        const current = await repo.read(path);
        if (!current) throw new Error('missing agenda');
        await update(path, {
          expectedVersion: current.version,
          frontmatter: { ...current.frontmatter, title: `${String(current.frontmatter.title)} (edited)` },
        });
      }
      return update(path, params);
    });
    try {
      expect(await store.settle(agenda.agendaId, 'session-edit', { kind: 'return' })).toBe('settled');
      const restored = await store.get(agenda.agendaId);
      expect(restored?.status).toBe('pending');
      expect(restored?.title).toContain('edited');
    } finally {
      spy.mockRestore();
    }
  });
});
