// Run store against real Postgres (migration 119). Skips without DATABASE_URL.
//
// The properties that matter: the people behind a preview come back exactly as saved and in order; a run is deleted as a
// unit; and a payload cannot outlive or precede its batch (foreign key to the plan).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { PgImportStore } from '../../src/contacts-import/import-store.js';
import { PgRunStore } from '../../src/contacts-import/run-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('contact import run store', () => {
  let pool: pg.Pool;
  let runs: PgRunStore;
  let plans: PgImportStore;
  const batches: string[] = [];
  const newRun = () => `pull-t${randomBytes(3).toString('hex')}-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    runs = new PgRunStore(pool);
    plans = new PgImportStore(pool);
  });
  afterAll(async () => {
    if (batches.length > 0) await pool.query('DELETE FROM contact_import_batches WHERE batch_id = ANY($1::text[])', [batches]);
    await pool.end();
  });

  async function batch(runId: string, n: number, people: { sourceKey: string; displayName: string }[]) {
    const id = `${runId}-${n}`;
    batches.push(id);
    await plans.savePlan(id, 'hash', { items: [] });
    await runs.savePayload(runId, id, people as never);
    return id;
  }

  it('returns a run\'s batches in order with the people exactly as saved', async () => {
    const run = newRun();
    await batch(run, 2, [{ sourceKey: 'b', displayName: 'Bo' }]);
    await batch(run, 1, [{ sourceKey: 'a', displayName: 'Al' }]);
    const got = await runs.getRun(run);
    expect(got.map((c) => c.batchId)).toEqual([`${run}-1`, `${run}-2`]);
    expect(got[0]!.people).toEqual([{ sourceKey: 'a', displayName: 'Al' }]);
    expect(Date.parse(got[0]!.createdAt)).not.toBeNaN();
  });

  it('deletes a run as a unit and leaves other runs alone', async () => {
    const one = newRun();
    const two = newRun();
    await batch(one, 1, [{ sourceKey: 'a', displayName: 'Al' }]);
    await batch(two, 1, [{ sourceKey: 'b', displayName: 'Bo' }]);
    await runs.deleteRun(one);
    expect(await runs.getRun(one)).toEqual([]);
    expect(await runs.getRun(two)).toHaveLength(1);
    expect(await runs.getRun('pull-nope-00000000')).toEqual([]);
  });

  it('refuses a payload for a batch that has no plan, and drops payloads with their batch', async () => {
    await expect(runs.savePayload(newRun(), 'no-such-batch', [])).rejects.toThrow();
    const run = newRun();
    const id = await batch(run, 1, [{ sourceKey: 'a', displayName: 'Al' }]);
    await pool.query('DELETE FROM contact_import_batches WHERE batch_id = $1', [id]);
    expect(await runs.getRun(run)).toEqual([]);
  });
});
