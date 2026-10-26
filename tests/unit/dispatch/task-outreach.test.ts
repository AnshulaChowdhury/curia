// Unit tests for TaskOutreachRepo: SQL shape and input normalization against a mock pool.
// The overlap/containment semantics run on Postgres in tests/integration/task-outreach.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { TaskOutreachRepo, type TaskOutreachInput } from '../../../src/dispatch/task-outreach.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';

const originator: TaskOriginator = {
  contactId: CONTACT_ID,
  systemRole: null,
  channel: 'signal',
  initiatedAt: '2026-10-26T12:00:00.000Z',
};

function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    task_id: TASK_ID,
    root_task_id: null,
    conversation_id: null,
    directing_event_id: null,
    originator,
    via: 'email',
    org_name: 'Acme',
    domains: ['acme.com'],
    addresses: ['a@acme.com'],
    contact_ids: [],
    given_contact: null,
    summary: 'asked about invoice',
    created_at: new Date('2026-10-26T12:00:00Z'),
    closed_at: null,
    expires_at: new Date('2026-11-25T12:00:00Z'),
    ...overrides,
  };
}

function mockPool(results: Array<{ rows: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce({ rowCount: r.rows.length, ...r });
  return { pool: { query } as unknown as DbPool, query };
}

const input: TaskOutreachInput = {
  taskId: TASK_ID,
  rootTaskId: null,
  conversationId: null,
  directingEventId: null,
  originator,
  via: 'email',
  orgName: 'Acme',
  domains: ['ACME.com', 'acme.com '],
  addresses: ['A@Acme.COM'],
  contactIds: [CONTACT_ID.toUpperCase()],
  givenContact: null,
  summary: 'asked about invoice',
  confirmed: true,
};

describe('TaskOutreachRepo.record', () => {
  it('merges into an existing open row when the UPDATE matches, without inserting', async () => {
    const { pool, query } = mockPool([{ rows: [dbRow()] }]);
    const row = await new TaskOutreachRepo(pool).record(input);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatch(/UPDATE task_outreach/);
    expect(row.taskId).toBe(TASK_ID);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('inserts when nothing merged, with lowercased, de-duplicated, parameterized values', async () => {
    const { pool, query } = mockPool([{ rows: [] }, { rows: [dbRow()] }]);
    await new TaskOutreachRepo(pool).record(input);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[1]! as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO task_outreach/);
    expect(sql).not.toContain('acme');
    expect(params).toContainEqual(['acme.com']);
    expect(params).toContainEqual(['a@acme.com']);
    expect(params).toContainEqual([CONTACT_ID]);
  });

  it('passes the same normalized arrays and scope to the merge UPDATE', async () => {
    const { pool, query } = mockPool([{ rows: [dbRow()] }]);
    await new TaskOutreachRepo(pool).record(input);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/closed_at IS NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(sql).toMatch(/&&/);
    expect(params).toContain(TASK_ID);
    expect(params).toContainEqual(['acme.com']);
    expect(params).toContainEqual(['a@acme.com']);
    expect(params).toContain('email');
  });

  it('merges only into a row of the same confirmed value, and inserts it as given (#2312)', async () => {
    const { pool, query } = mockPool([{ rows: [] }, { rows: [dbRow()] }]);
    await new TaskOutreachRepo(pool).record({ ...input, confirmed: false });
    const [updateSql, updateParams] = query.mock.calls[0]! as [string, unknown[]];
    // Row selection pins confirmed; the SET list never touches it (no OR-upgrade).
    expect(updateSql).toMatch(/AND confirmed = \$9::boolean/);
    expect(updateSql).not.toMatch(/confirmed = t\.confirmed/);
    expect(updateParams[8]).toBe(false);
    const [insertSql, insertParams] = query.mock.calls[1]! as [string, unknown[]];
    expect(insertSql).toMatch(/confirmed\)/);
    expect(insertParams[12]).toBe(false);
  });

  it('maps confirmed strictly: only a literal true is confirmed (#2312)', async () => {
    const { pool } = mockPool([{ rows: [dbRow({ confirmed: true })] }, { rows: [dbRow({ confirmed: null })] }, { rows: [dbRow()] }]);
    const repo = new TaskOutreachRepo(pool);
    expect((await repo.getById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))?.confirmed).toBe(true);
    expect((await repo.getById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))?.confirmed).toBe(false);
    expect((await repo.getById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))?.confirmed).toBe(false);
  });

  it('drops non-uuid contact ids', async () => {
    const { pool, query } = mockPool([{ rows: [] }, { rows: [dbRow()] }]);
    await new TaskOutreachRepo(pool).record({ ...input, contactIds: ['not-a-uuid', CONTACT_ID] });
    const params = query.mock.calls[1]![1] as unknown[];
    expect(params).toContainEqual([CONTACT_ID]);
  });
});

describe('TaskOutreachRepo finders', () => {
  it('findOpen filters open, unexpired rows, newest first, parameterized limit', async () => {
    const { pool, query } = mockPool([{ rows: [dbRow()] }]);
    const rows = await new TaskOutreachRepo(pool).findOpen(5);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/closed_at IS NULL AND expires_at > now\(\)/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual([5]);
    expect(rows[0]!.domains).toEqual(['acme.com']);
  });

  it('findOpenByAddress lowercases and filters open rows', async () => {
    const { pool, query } = mockPool([{ rows: [] }]);
    await new TaskOutreachRepo(pool).findOpenByAddress(' Bob@ACME.com ');
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/closed_at IS NULL AND expires_at > now\(\)/);
    expect(params).toEqual(['bob@acme.com']);
  });

  it('findOpenByDomain lowercases', async () => {
    const { pool, query } = mockPool([{ rows: [] }]);
    await new TaskOutreachRepo(pool).findOpenByDomain('ACME.com');
    expect(query.mock.calls[0]![1]).toEqual(['acme.com']);
  });

  it('findOpenByContact returns [] for a non-uuid without querying', async () => {
    const { pool, query } = mockPool([]);
    expect(await new TaskOutreachRepo(pool).findOpenByContact('nope')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('findOpenByContact queries with a lowercased uuid', async () => {
    const { pool, query } = mockPool([{ rows: [] }]);
    await new TaskOutreachRepo(pool).findOpenByContact(CONTACT_ID.toUpperCase());
    expect(query.mock.calls[0]![1]).toEqual([CONTACT_ID]);
  });

  // The band review reads a link's row by id, open or not (#2312 Task 5).
  it('getById reads one row by id, whatever its state, parameterized', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { pool, query } = mockPool([{ rows: [dbRow({ closed_at: new Date(0) })] }]);
    const row = await new TaskOutreachRepo(pool).getById(id.toUpperCase());
    expect(row?.id).toBe(id);
    expect(row?.originator).toEqual(originator);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(sql).not.toMatch(/closed_at IS NULL/);
    expect(params).toEqual([id]);
  });

  it('getById returns null for a missing row, and for a non-uuid without querying', async () => {
    const { pool, query } = mockPool([{ rows: [] }]);
    const repo = new TaskOutreachRepo(pool);
    expect(await repo.getById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
    expect(await repo.getById('nope')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('TaskOutreachRepo.learnCounterparty and closeForTask', () => {
  it('learnCounterparty appends a lowercased address and contact id', async () => {
    const { pool, query } = mockPool([{ rows: [] }]);
    await new TaskOutreachRepo(pool).learnCounterparty('row-id', { address: 'X@Acme.com', contactId: CONTACT_ID });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/UPDATE task_outreach/);
    expect(params).toEqual(['row-id', ['x@acme.com'], [CONTACT_ID]]);
  });

  it('learnCounterparty with nothing to learn does not query', async () => {
    const { pool, query } = mockPool([]);
    await new TaskOutreachRepo(pool).learnCounterparty('row-id', {});
    expect(query).not.toHaveBeenCalled();
  });

  it('closeForTask returns the number of rows closed', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
    const n = await new TaskOutreachRepo({ query } as unknown as DbPool).closeForTask(TASK_ID);
    expect(n).toBe(2);
    expect(query.mock.calls[0]![0]).toMatch(/closed_at = now\(\)/);
    expect(query.mock.calls[0]![1]).toEqual([TASK_ID]);
  });
});
