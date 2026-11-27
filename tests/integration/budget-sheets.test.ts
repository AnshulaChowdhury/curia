// The stored spreadsheets against real Postgres: versions, expiry and the limit. Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { SheetStore, MAX_STORED_SHEETS } from '../../src/budget/sheet-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const workbook = (v: number) => ({ sheetOrder: ['s1'], sheets: { s1: { name: 'Budget', cellData: { '0': { '0': { v } } } } } });

describeIf('budget sheet store', () => {
  let pool: pg.Pool;
  let store: SheetStore;
  const wipe = async () => { await pool.query('DELETE FROM budget_sheets'); };
  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await requireCuriaTestDatabase(pool); store = new SheetStore(pool); });
  beforeEach(wipe);
  afterAll(async () => { await wipe(); await pool.end(); });

  it('stores a cleaned workbook and never overwrites a newer version', async () => {
    const made = await store.create({ name: '  <My> budget ', workbook: { ...workbook(1), resources: [1] } });
    expect(made).toMatchObject({ name: 'My budget', version: 1 });
    expect(Object.keys((await store.get(made.id)).workbook)).not.toContain('resources');
    expect((await store.save(made.id, 1, workbook(2))).version).toBe(2);
    await expect(store.save(made.id, 1, workbook(3))).rejects.toMatchObject({ kind: 'conflict' });
    expect((await store.get(made.id)).workbook.sheets['s1']!.cellData['0']!['0']!.v).toBe(2);
    await expect(store.save(made.id, '2', workbook(3))).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('hides and removes an expired sheet, and extends one that is edited', async () => {
    const made = await store.create({ name: 'a', workbook: workbook(1) });
    await pool.query(`UPDATE budget_sheets SET expires_at = now() + interval '1 hour' WHERE id = $1`, [made.id]);
    const saved = await store.save(made.id, 1, workbook(2));
    expect(Date.parse(saved.expiresAt) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    await pool.query(`UPDATE budget_sheets SET expires_at = now() - interval '1 minute' WHERE id = $1`, [made.id]);
    await expect(store.get(made.id)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(store.save(made.id, 2, workbook(3))).rejects.toMatchObject({ kind: 'not_found' });
    expect(await store.list()).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM budget_sheets')).rows[0]).toEqual({ n: 0 });
  });

  it('attaches one sheet to a chat at a time, and keeps what it detaches', async () => {
    const first = await store.create({ name: 'first', workbook: workbook(1), conversationId: 'chat-1' });
    expect((await store.attached('chat-1'))?.id).toBe(first.id);
    expect(await store.attached('chat-2')).toBeNull();
    const second = await store.create({ name: 'second', workbook: workbook(2), conversationId: 'chat-1' });
    expect(await store.attachedInfo('chat-1')).toMatchObject({ id: second.id, name: 'second' });
    expect(await store.list()).toHaveLength(2);
    await store.detach('chat-1');
    expect(await store.attached('chat-1')).toBeNull();
    expect((await store.get(second.id)).name).toBe('second');
  });

  it('forgets an expired attachment, and refuses an id that is not one', async () => {
    const made = await store.create({ name: 'a', workbook: workbook(1), conversationId: 'chat-3' });
    await pool.query(`UPDATE budget_sheets SET expires_at = now() - interval '1 minute' WHERE id = $1`, [made.id]);
    expect(await store.attached('chat-3')).toBeNull();
    for (const bad of ['', 'a b', 'x'.repeat(201), 5]) await expect(store.attached(bad)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(store.create({ name: 'b', workbook: workbook(1), conversationId: "'; drop" })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('holds a limited number, and deletes', async () => {
    const made = [];
    for (let i = 0; i < MAX_STORED_SHEETS; i++) made.push(await store.create({ name: `s${i}`, workbook: workbook(i) }));
    await expect(store.create({ name: 'one more', workbook: workbook(0) })).rejects.toMatchObject({ kind: 'conflict' });
    await store.remove(made[0]!.id);
    await expect(store.remove(made[0]!.id)).rejects.toMatchObject({ kind: 'not_found' });
    expect(await store.list()).toHaveLength(MAX_STORED_SHEETS - 1);
  });
});
