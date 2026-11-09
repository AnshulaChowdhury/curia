// Matrix exporter store against real Postgres (migration 123). Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PgExportStore } from '../../src/contacts-import/export-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const room = (hash: string, fromThem: number) => ({ roomHash: hash, network: 'whatsapp', members: [{ ghostId: 'g1', fromThem, fromMe: 1 }] });

describeIf('contact export store', () => {
  let pool: pg.Pool;
  let store: PgExportStore;
  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await requireCuriaTestDatabase(pool); store = new PgExportStore(pool); });
  const clean = async () => { await pool.query('DELETE FROM contact_message_facts'); await pool.query('DELETE FROM contact_export_runs'); await pool.query('DELETE FROM contact_export_log'); };
  beforeEach(clean);
  afterAll(async () => { await clean(); await pool.end(); });

  it('one open run at a time; claim marks it running and lists finished rooms', async () => {
    const a = await store.request(new Date(0));
    expect(a.created).toBe(true);
    expect((await store.request(new Date(0))).run.runId).toBe(a.run.runId);
    expect((await store.claim())!.run.status).toBe('running');
    await store.saveRooms(a.run.runId, [room('aaaaaaaaaaaaaaaa', 2)]);
    expect((await store.claim())!.doneRooms).toEqual(['aaaaaaaaaaaaaaaa']);
    expect((await store.getRun(a.run.runId))!.roomsDone).toBe(1);
  });

  it('re-sending a room replaces its counts instead of adding to them', async () => {
    const { run } = await store.request(new Date(0));
    await store.saveRooms(run.runId, [room('bbbbbbbbbbbbbbbb', 5)]);
    await store.saveRooms(run.runId, [room('bbbbbbbbbbbbbbbb', 7)]);
    const r = await pool.query('SELECT from_them FROM contact_message_facts');
    expect(r.rows).toEqual([{ from_them: 7 }]);
  });

  it('a finished run accepts nothing more and a new one can then be requested', async () => {
    const { run } = await store.request(new Date(0));
    expect(await store.finish(run.runId, 'done')).toBe(true);
    expect(await store.saveRooms(run.runId, [room('cccccccccccccccc', 1)])).toBe(false);
    expect(await store.finish(run.runId, 'done')).toBe(false);
    expect((await store.request(new Date(0))).created).toBe(true);
  });

  it('keeps the newest 500 log lines, oldest first when read', async () => {
    await store.appendLog('exp-1-aaaaaaaa', Array.from({ length: 505 }, (_, i) => ({ level: 'info' as const, message: `l${i}` })));
    const all = await store.recentLog(1000);
    expect(all).toHaveLength(500);
    expect(all[0]!.message).toBe('l5');
    expect(all[499]!.message).toBe('l504');
    expect((await store.recentLog(2)).map((l) => l.message)).toEqual(['l503', 'l504']);
  });
});
