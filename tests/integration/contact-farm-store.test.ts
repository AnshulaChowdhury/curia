// Contacts farm store against real Postgres (migration 120). Skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PgFarmStore } from '../../src/contacts-import/farm-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const d = (email: string, over: object = {}) => ({ email, domain: email.split('@')[1]!, received: 1, sent: 0, copied: 0, first: 1_000, last: 2_000, ...over });

describeIf('contact farm store', () => {
  let pool: pg.Pool;
  let store: PgFarmStore;
  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await requireCuriaTestDatabase(pool); store = new PgFarmStore(pool); });
  const clean = async () => { await pool.query('DELETE FROM contact_farm_facts'); await pool.query('DELETE FROM contact_farm_runs'); };
  beforeEach(clean);
  afterAll(async () => { await clean(); await pool.end(); });

  it('adds counts across pages, keeps first/last seen and the longest name, and tracks progress', async () => {
    await store.startRun('moonray', new Date(0), false);
    await store.commitPage('moonray', 'c1', 10, [d('a@x.com', { name: 'A', first: 1_000, last: 2_000 })]);
    await store.commitPage('moonray', null, 5, [d('a@x.com', { name: 'Alice Smith', sent: 2, first: 500, last: 1_500 })]);
    expect((await store.facts('moonray', 10))[0]).toMatchObject({ email: 'a@x.com', displayName: 'Alice Smith', received: 2, sent: 2, firstSeen: new Date(500_000).toISOString(), lastSeen: new Date(2_000_000).toISOString() });
    expect(await store.getRun('moonray')).toMatchObject({ messagesScanned: 15, pagesScanned: 2, cursor: null });
    expect(await store.countFacts('moonray')).toBe(1);
  });

  it('resume keeps the cursor and counts; a fresh start clears them', async () => {
    await store.startRun('moonray', new Date(0), false);
    await store.commitPage('moonray', 'c9', 3, [d('a@x.com')]);
    await store.finish('moonray', 'failed', 'Boom');
    expect(await store.startRun('moonray', new Date(0), true)).toMatchObject({ status: 'running', cursor: 'c9', errorKind: null, messagesScanned: 3 });
    expect(await store.countFacts('moonray')).toBe(1);
    expect(await store.startRun('moonray', new Date(0), false)).toMatchObject({ cursor: null, messagesScanned: 0 });
    expect(await store.countFacts('moonray')).toBe(0);
  });

  it('a page whose write fails changes nothing (counts and cursor move together)', async () => {
    await store.startRun('moonray', new Date(0), false);
    await expect(store.commitPage('moonray', 'c1', 1, [d('a@x.com'), d('b@x.com', { first: Number.NaN })])).rejects.toThrow();
    expect(await store.countFacts('moonray')).toBe(0);
    expect((await store.getRun('moonray'))!.cursor).toBeNull();
  });

  it('only accepts the known statuses', async () => {
    await store.startRun('moonray', new Date(0), false);
    await expect(pool.query("UPDATE contact_farm_runs SET status = 'weird'")).rejects.toThrow();
  });
});
