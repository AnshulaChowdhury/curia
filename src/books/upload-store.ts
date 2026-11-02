// upload-store.ts — bank files uploaded on the Books page, waiting for the books run.
//
// The books agent lists the waiting files, downloads each, and reports it processed; then the bytes are deleted and only
// the name, size and sha256 remain, so the same file can never be uploaded or taken twice. Nothing here opens a file.

import { createHash } from 'node:crypto';
import type { DbPool } from '../db/connection.js';

export interface UploadSummary {
  id: string;
  name: string;
  size: number;
  status: 'waiting' | 'processed';
  uploaded_at: string;
  processed_at: string | null;
}

export type AddResult = { status: 'added'; id: string } | { status: 'duplicate'; id: string; name: string; processed: boolean };

export class UploadStore {
  constructor(private readonly pool: DbPool) {}

  async add(name: string, bytes: Buffer): Promise<AddResult> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const ins = await this.pool.query<{ id: string }>(
      `INSERT INTO books_uploads (name, sha256, size, content) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sha256) DO NOTHING RETURNING id`,
      [name, sha, bytes.length, bytes],
    );
    if (ins.rows[0]) return { status: 'added', id: ins.rows[0].id };
    const dup = await this.pool.query<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM books_uploads WHERE sha256 = $1',
      [sha],
    );
    const d = dup.rows[0]!;
    return { status: 'duplicate', id: d.id, name: d.name, processed: d.status === 'processed' };
  }

  async list(limit = 50): Promise<UploadSummary[]> {
    const { rows } = await this.pool.query<UploadSummary & { uploaded_at: Date; processed_at: Date | null }>(
      `SELECT id, name, size, status, uploaded_at, processed_at FROM books_uploads ORDER BY uploaded_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(r => ({ ...r, uploaded_at: new Date(r.uploaded_at).toISOString(), processed_at: r.processed_at ? new Date(r.processed_at).toISOString() : null }));
  }

  /** Files waiting for the books run, oldest first. */
  async listWaiting(): Promise<Array<{ id: string; name: string; size: number; modifiedTime: string; md5: string }>> {
    const { rows } = await this.pool.query<{ id: string; name: string; size: number; uploaded_at: Date; sha256: string }>(
      `SELECT id, name, size, uploaded_at, sha256 FROM books_uploads WHERE status = 'waiting' AND content IS NOT NULL ORDER BY uploaded_at`,
    );
    return rows.map(r => ({ id: r.id, name: r.name, size: r.size, modifiedTime: new Date(r.uploaded_at).toISOString(), md5: r.sha256 }));
  }

  /** The bytes of a waiting file, or null if there is no such waiting file. */
  async read(id: string): Promise<{ name: string; bytes: Buffer } | null> {
    const { rows } = await this.pool.query<{ name: string; content: Buffer }>(
      `SELECT name, content FROM books_uploads WHERE id = $1 AND status = 'waiting' AND content IS NOT NULL`,
      [id],
    );
    return rows[0] ? { name: rows[0].name, bytes: rows[0].content } : null;
  }

  /** The books run has recorded the file: drop the bytes, keep the fingerprint. False if it was not waiting. */
  async markProcessed(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE books_uploads SET status = 'processed', processed_at = now(), content = NULL WHERE id = $1 AND status = 'waiting'`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /** A person removes a file that has not been taken yet (a wrong upload). The fingerprint goes too, so it can be re-uploaded. */
  async remove(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM books_uploads WHERE id = $1 AND status = 'waiting'`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
