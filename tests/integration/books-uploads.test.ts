// Books uploads against real Postgres: the SQL behind the upload page. Skips without DATABASE_URL.
//   - the same bytes are never stored twice, even after the file was processed;
//   - processing a file deletes its bytes but keeps its fingerprint;
//   - only a waiting file can be read, taken or removed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { UploadStore } from '../../src/books/upload-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('books uploads', () => {
  let pool: pg.Pool;
  let store: UploadStore;
  const made: string[] = [];
  const file = () => Buffer.from(`OFXHEADER:100\n<OFX>${randomBytes(8).toString('hex')}</OFX>`);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new UploadStore(pool);
  });
  afterAll(async () => {
    if (made.length > 0) await pool.query('DELETE FROM books_uploads WHERE id = ANY($1::uuid[])', [made]);
    await pool.end();
  });

  it('stores a file, lists it as waiting, and reads its bytes back', async () => {
    const bytes = file();
    const r = await store.add('Chequing.qbo', bytes);
    expect(r.status).toBe('added');
    made.push(r.id);
    expect((await store.listWaiting()).some(f => f.id === r.id && f.size === bytes.length)).toBe(true);
    expect((await store.read(r.id))?.bytes.equals(bytes)).toBe(true);
  });

  it('refuses the same bytes twice, waiting or processed', async () => {
    const bytes = file();
    const a = await store.add('a.qbo', bytes);
    made.push(a.id);
    expect(await store.add('copy.qbo', bytes)).toMatchObject({ status: 'duplicate', id: a.id, processed: false });
    expect(await store.markProcessed(a.id)).toBe(true);
    expect(await store.add('again.qbo', bytes)).toMatchObject({ status: 'duplicate', id: a.id, processed: true });
  });

  it('processing deletes the bytes, keeps the row, and cannot be done twice', async () => {
    const a = await store.add('p.qbo', file());
    made.push(a.id);
    expect(await store.markProcessed(a.id)).toBe(true);
    expect(await store.markProcessed(a.id)).toBe(false);
    expect(await store.read(a.id)).toBeNull();
    const { rows } = await pool.query<{ content: Buffer | null; status: string }>('SELECT content, status FROM books_uploads WHERE id = $1', [a.id]);
    expect(rows[0]).toMatchObject({ content: null, status: 'processed' });
    expect((await store.list()).find(u => u.id === a.id)).toMatchObject({ status: 'processed' });
    expect((await store.listWaiting()).some(f => f.id === a.id)).toBe(false);
  });

  it('removes a waiting file, freeing the same bytes to be uploaded again, but never a processed one', async () => {
    const bytes = file();
    const a = await store.add('w.qbo', bytes);
    expect(await store.remove(a.id)).toBe(true);
    expect(await store.remove(a.id)).toBe(false);
    const again = await store.add('w2.qbo', bytes);
    expect(again.status).toBe('added');
    made.push(again.id);
    await store.markProcessed(again.id);
    expect(await store.remove(again.id)).toBe(false);
  });
});
