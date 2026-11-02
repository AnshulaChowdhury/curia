// Books batches against real Postgres: the SQL behind the review flow. Skips without DATABASE_URL.
//
// The properties that matter, because a row that is approved gets posted to the real books:
//   - pushing the same batch again never touches an edit, a decision or a result;
//   - a posted row is final: no edit, decision or second result can change it;
//   - only approved rows with no result are offered for posting, and a failed row goes back to pending.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { BatchError, BatchStore, type PushedRow } from '../../src/books/batch-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const row = (id: string, extra: Record<string, unknown> = {}): PushedRow =>
  ({ id, account: 'rbc-chequing-4530', amount: '-12.00', date: '2026-11-02', description: `ROW ${id}`, flags: [], category: 'Bank charges', ...extra });

describeIf('books batches', () => {
  let pool: pg.Pool;
  let store: BatchStore;
  const created: string[] = [];
  const newBatch = () => { const id = randomBytes(8).toString('hex'); created.push(id); return id; };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new BatchStore(pool);
  });

  afterAll(async () => {
    if (created.length > 0) await pool.query('DELETE FROM books_batches WHERE batch_id = ANY($1::text[])', [created]);
    await pool.end();
  });

  it('stores a batch and reads it back with the rows in date order', async () => {
    const id = newBatch();
    await store.upsertBatch(id, { status: 'ready', counts: { total: 2 } }, [row('r2', { date: '2026-11-03' }), row('r1')]);
    const b = await store.getBatch(id);
    expect(b.report).toMatchObject({ status: 'ready' });
    expect(b.rows.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(b.rows[0]).toMatchObject({ decision: 'pending', result: null, edits: {} });
    const list = (await store.listBatches()).find(x => x.batch_id === id)!;
    expect(list).toMatchObject({ rows: 2, pending: 2, approved: 0, posted: 0 });
  });

  it('a re-push adds new rows and refreshes the report but never touches edits, decisions or results', async () => {
    const id = newBatch();
    await store.upsertBatch(id, { v: 1 }, [row('r1'), row('r2'), row('r3')]);
    await store.editRow(id, 'r1', { category: 'Software subscriptions', payee: 'Canva' });
    await store.decide(id, ['r2'], 'approved');
    await store.recordResults(id, { r2: { status: 'posted', qbo_id: '55', entity: 'Purchase' } });
    await store.decide(id, ['r3'], 'skipped');

    await store.upsertBatch(id, { v: 2 }, [row('r1', { description: 'CHANGED' }), row('r2', { description: 'CHANGED' }), row('r3', { description: 'CHANGED' }), row('r4')]);
    const b = await store.getBatch(id);
    expect(b.report).toEqual({ v: 2 });
    const by = Object.fromEntries(b.rows.map(r => [r.id, r]));
    expect(by['r1']).toMatchObject({ decision: 'pending', edits: { category: 'Software subscriptions', payee: 'Canva' } });
    expect(by['r1']!.row['description']).toBe('CHANGED');              // pending: pushed data refreshed
    expect(by['r1']!.row['category']).toBe('Software subscriptions');  // the edit still wins
    expect(by['r2']).toMatchObject({ decision: 'approved', result: { status: 'posted', qbo_id: '55' } });
    expect(by['r2']!.row['description']).toBe('ROW r2');               // posted: untouched
    expect(by['r3']).toMatchObject({ decision: 'skipped' });
    expect(by['r3']!.row['description']).toBe('ROW r3');               // decided: untouched
    expect(by['r4']).toMatchObject({ decision: 'pending' });
  });

  it('edits only the allowed fields, only while pending, and removes an edit with null', async () => {
    const id = newBatch();
    await store.upsertBatch(id, {}, [row('r1')]);
    const edited = await store.editRow(id, 'r1', { class: 'Operations', location: 'Krisette and Co.' });
    expect(edited.row).toMatchObject({ class: 'Operations', location: 'Krisette and Co.' });
    const cleared = await store.editRow(id, 'r1', { class: null });
    expect(cleared.edits).toEqual({ location: 'Krisette and Co.' });
    await expect(store.editRow(id, 'r1', { amount: '1' })).rejects.toBeInstanceOf(BatchError);
    await expect(store.editRow(id, 'nope', { class: 'x' })).rejects.toMatchObject({ kind: 'not_found' });
    await store.decide(id, ['r1'], 'approved');
    await expect(store.editRow(id, 'r1', { class: 'x' })).rejects.toMatchObject({ kind: 'locked' });
  });

  it('will not approve a flagged row until it has a category, and changes nothing if any row is refused', async () => {
    const id = newBatch();
    await store.upsertBatch(id, {}, [
      row('ok'),
      row('flagged', { category: '', flags: [{ kind: 'needs_category', message: 'no rule' }] }),
    ]);
    await expect(store.decide(id, ['ok', 'flagged'], 'approved')).rejects.toThrow(/choose a category/);
    expect((await store.getBatch(id)).rows.map(r => r.decision)).toEqual(['pending', 'pending']);   // all or nothing
    await store.editRow(id, 'flagged', { category: 'Bank charges' });
    expect(await store.decide(id, ['ok', 'flagged'], 'approved')).toBe(2);
    await expect(store.decide(id, ['ok', 'ghost'], 'approved')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('offers approved rows with the edits merged in, until the agent reports on them', async () => {
    const id = newBatch();
    await store.upsertBatch(id, {}, [row('r1'), row('r2'), row('r3')]);
    await store.editRow(id, 'r1', { category: 'Dues and subscriptions' });
    await store.decide(id, ['r1', 'r2'], 'approved');
    const mine = (await store.approvedForPosting()).find(b => b.batch_id === id)!;
    expect(mine.rows.map(r => r['id'])).toEqual(['r1', 'r2']);
    expect(mine.rows[0]).toMatchObject({ category: 'Dues and subscriptions', amount: '-12.00' });
    await store.recordResults(id, { r1: { status: 'posted', qbo_id: '9' }, r2: { status: 'posted', qbo_id: '10' } });
    expect((await store.approvedForPosting()).find(b => b.batch_id === id)).toBeUndefined();
  });

  it('a failed or by-hand result sends the row back to pending, and approving again offers it afresh', async () => {
    const id = newBatch();
    await store.upsertBatch(id, {}, [row('f'), row('m'), row('s')]);
    await store.decide(id, ['f', 'm', 's'], 'approved');
    const out = await store.recordResults(id, {
      f: { status: 'failed', message: 'Account is missing' },
      m: { status: 'manual', message: 'enter by hand' },
      s: { status: 'skipped', message: 'already in QuickBooks' },
    });
    expect(out).toEqual({ recorded: 3, ignored: [] });
    let by = Object.fromEntries((await store.getBatch(id)).rows.map(r => [r.id, r]));
    expect(by['f']).toMatchObject({ decision: 'pending', result: { status: 'failed', message: 'Account is missing' } });
    expect(by['m']).toMatchObject({ decision: 'pending', result: { status: 'manual' } });
    expect(by['s']).toMatchObject({ decision: 'skipped', result: { status: 'skipped' } });
    expect((await store.approvedForPosting()).find(b => b.batch_id === id)).toBeUndefined();
    await store.decide(id, ['f'], 'approved');
    by = Object.fromEntries((await store.getBatch(id)).rows.map(r => [r.id, r]));
    expect(by['f']!.result).toBeNull();
    expect((await store.approvedForPosting()).find(b => b.batch_id === id)!.rows.map(r => r['id'])).toEqual(['f']);
    const summary = (await store.listBatches()).find(x => x.batch_id === id)!;
    expect(summary).toMatchObject({ manual: 1, skipped: 1, approved: 1 });
  });

  it('a posted row is final: it cannot be edited, un-approved, skipped or reported on again', async () => {
    const id = newBatch();
    await store.upsertBatch(id, {}, [row('r1')]);
    await store.decide(id, ['r1'], 'approved');
    await store.recordResults(id, { r1: { status: 'posted', qbo_id: '1', entity: 'Purchase' } });
    await expect(store.editRow(id, 'r1', { category: 'x' })).rejects.toMatchObject({ kind: 'locked' });
    for (const d of ['pending', 'skipped', 'approved'] as const) {
      await expect(store.decide(id, ['r1'], d)).rejects.toMatchObject({ kind: 'locked' });
    }
    const again = await store.recordResults(id, { r1: { status: 'failed', message: 'late duplicate' } });
    expect(again).toEqual({ recorded: 0, ignored: ['r1'] });
    expect((await store.getBatch(id)).rows[0]).toMatchObject({ decision: 'approved', result: { status: 'posted', qbo_id: '1' } });
  });

  it('ignores results for rows that were not approved, and rejects a malformed or unknown report', async () => {
    const id = newBatch();
    await store.upsertBatch(id, {}, [row('r1')]);
    expect(await store.recordResults(id, { r1: { status: 'posted' }, nope: { status: 'posted' } })).toEqual({ recorded: 0, ignored: ['r1', 'nope'] });
    await expect(store.recordResults(id, { r1: { status: 'done' } })).rejects.toBeInstanceOf(BatchError);
    await expect(store.recordResults('ffffffffffffffff', { r1: { status: 'posted' } })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('stores hostile text as plain data', async () => {
    const id = newBatch();
    const evil = `'); DROP TABLE books_batches; -- <script>alert(1)</script>`;
    await store.upsertBatch(id, {}, [row('r1', { description: evil })]);
    expect((await store.getBatch(id)).rows[0]!.row['description']).toBe(evil);
    await store.editRow(id, 'r1', { payee: evil.slice(0, 150) });
    expect((await pool.query('SELECT count(*)::int AS n FROM books_batches')).rows[0].n).toBeGreaterThan(0);
  });

  it('Morning Brief: counts the newest batch, and finds the rows that need the owner', async () => {
    const id = newBatch();
    await store.upsertBatch(id, {}, [
      row('a', { qbo_status: 'already booked' }), row('b', { qbo_status: 'MISSING' }), row('c', { qbo_status: 'MISSING' }),
      row('d', { qbo_status: 'TIMING' }), row('e', { qbo_status: 'MISSING', category: undefined, description: 'MYSTERY VENDOR', date: '2026-12-31' }),
    ]);
    const before = await store.reviewCount();
    // the newest batch is the one just pushed: 5 rows, 2 matched (already booked + timing)
    expect(await store.latestBatchCounts()).toMatchObject({ batchId: id, total: 5, matched: 2 });
    await store.decide(id, ['b', 'c'], 'approved');
    await store.recordResults(id, { b: { status: 'posted', qbo_id: '9', entity: 'Purchase' }, c: { status: 'failed', message: 'Account is missing' } });
    // b is posted (counts as matched, leaves review), c failed (back with the owner), a, d, e are undecided
    expect(await store.latestBatchCounts()).toMatchObject({ total: 5, matched: 3 });
    const cards = await store.reviewCards(200);
    const mine = cards.filter(c => c.batchId === id.slice(0, 8));
    expect(mine.map(c => c.id).sort()).toEqual(['a', 'c', 'd', 'e']);
    expect(mine[0]!.id).toBe('e');                                                 // newest transaction date first
    expect(mine.find(c => c.id === 'c')!.reasons).toEqual(['Could not be posted: Account is missing']);
    expect(mine.find(c => c.id === 'e')!.reasons).toEqual(['Needs a category']);
    expect(await store.reviewCount()).toBe(before - 1);                             // b was posted and left review; c failed and is still counted
    expect(await store.reviewCards(1)).toHaveLength(1);
  });
});
