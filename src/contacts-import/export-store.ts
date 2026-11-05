// export-store.ts — run requests and message-activity facts from the Mac mini's Matrix exporter (migration 123).
// Counts only. Two implementations behind one interface: Postgres and in-memory (tests).

import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

export type ExportStatus = 'requested' | 'running' | 'done' | 'failed';

export interface ExportRun {
  runId: string;
  status: ExportStatus;
  since: string;
  roomsDone: number;
  errorKind: string | null;
  requestedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface MemberFact {
  ghostId: string;
  displayName?: string;
  phone?: string;
  fromThem: number;
  fromMe: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface RoomFacts {
  roomHash: string;
  network: string;
  members: MemberFact[];
}

export interface ExportStore {
  /** Makes a run request unless one is already open; returns the open one. */
  request(since: Date): Promise<{ run: ExportRun; created: boolean }>;
  /** The run the job should work on (requested or running), marked running, with the rooms already done. */
  claim(): Promise<{ run: ExportRun; doneRooms: string[] } | null>;
  getRun(runId: string): Promise<ExportRun | null>;
  latest(): Promise<ExportRun | null>;
  /** Stores rooms' counts and marks them done, atomically. False when the run is not open. */
  saveRooms(runId: string, rooms: RoomFacts[]): Promise<boolean>;
  finish(runId: string, status: 'done' | 'failed', errorKind?: string): Promise<boolean>;
  countFacts(): Promise<number>;
}

export const newRunId = (now: number): string => `exp-${now.toString(36)}-${randomBytes(4).toString('hex')}`;

export class InMemoryExportStore implements ExportStore {
  runs: ExportRun[] = [];
  done = new Map<string, Set<string>>();
  facts = new Map<string, MemberFact & { network: string; runId: string }>();
  constructor(private readonly now: () => number = Date.now) {}

  private open(): ExportRun | undefined {
    return this.runs.find((r) => r.status === 'requested' || r.status === 'running');
  }
  async request(since: Date) {
    const existing = this.open();
    if (existing) return { run: existing, created: false };
    const t = new Date(this.now()).toISOString();
    const run: ExportRun = { runId: newRunId(this.now()), status: 'requested', since: since.toISOString(), roomsDone: 0, errorKind: null, requestedAt: t, updatedAt: t, finishedAt: null };
    this.runs.push(run);
    return { run, created: true };
  }
  async claim() {
    const run = this.open();
    if (!run) return null;
    run.status = 'running';
    return { run, doneRooms: [...(this.done.get(run.runId) ?? [])] };
  }
  async getRun(runId: string) { return this.runs.find((r) => r.runId === runId) ?? null; }
  async latest() { return this.runs[this.runs.length - 1] ?? null; }
  async saveRooms(runId: string, rooms: RoomFacts[]) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run || (run.status !== 'running' && run.status !== 'requested')) return false;
    const set = this.done.get(runId) ?? new Set<string>();
    for (const room of rooms) {
      for (const m of room.members) this.facts.set(`${room.roomHash}\u0000${m.ghostId}`, { ...m, network: room.network, runId });
      set.add(room.roomHash);
    }
    this.done.set(runId, set);
    run.roomsDone = set.size;
    return true;
  }
  async finish(runId: string, status: 'done' | 'failed', errorKind?: string) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run || (run.status !== 'running' && run.status !== 'requested')) return false;
    run.status = status;
    run.errorKind = errorKind ?? null;
    run.finishedAt = new Date(this.now()).toISOString();
    return true;
  }
  async countFacts() { return this.facts.size; }
}

interface RunRow { run_id: string; status: ExportStatus; since: Date; rooms_done: number; error_kind: string | null; requested_at: Date; updated_at: Date; finished_at: Date | null }
const toRun = (r: RunRow): ExportRun => ({
  runId: r.run_id, status: r.status, since: r.since.toISOString(), roomsDone: r.rooms_done, errorKind: r.error_kind,
  requestedAt: r.requested_at.toISOString(), updatedAt: r.updated_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
});

export class PgExportStore implements ExportStore {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>, private readonly now: () => number = Date.now) {}

  async request(since: Date) {
    const open = await this.pool.query<RunRow>("SELECT * FROM contact_export_runs WHERE status IN ('requested','running') ORDER BY requested_at DESC LIMIT 1");
    if (open.rows[0]) return { run: toRun(open.rows[0]), created: false };
    const r = await this.pool.query<RunRow>('INSERT INTO contact_export_runs (run_id, since) VALUES ($1, $2) RETURNING *', [newRunId(this.now()), since]);
    return { run: toRun(r.rows[0]!), created: true };
  }

  async claim() {
    const r = await this.pool.query<RunRow>(
      `UPDATE contact_export_runs SET status = 'running', updated_at = now()
       WHERE run_id = (SELECT run_id FROM contact_export_runs WHERE status IN ('requested','running') ORDER BY requested_at LIMIT 1)
       RETURNING *`);
    if (!r.rows[0]) return null;
    const rooms = await this.pool.query<{ room_hash: string }>('SELECT room_hash FROM contact_export_rooms WHERE run_id = $1', [r.rows[0].run_id]);
    return { run: toRun(r.rows[0]), doneRooms: rooms.rows.map((x) => x.room_hash) };
  }

  async getRun(runId: string) {
    const r = await this.pool.query<RunRow>('SELECT * FROM contact_export_runs WHERE run_id = $1', [runId]);
    return r.rows[0] ? toRun(r.rows[0]) : null;
  }

  async latest() {
    const r = await this.pool.query<RunRow>('SELECT * FROM contact_export_runs ORDER BY requested_at DESC LIMIT 1');
    return r.rows[0] ? toRun(r.rows[0]) : null;
  }

  async saveRooms(runId: string, rooms: RoomFacts[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const open = await client.query("SELECT 1 FROM contact_export_runs WHERE run_id = $1 AND status IN ('requested','running') FOR UPDATE", [runId]);
      if (open.rowCount === 0) { await client.query('ROLLBACK'); return false; }
      for (const room of rooms) {
        for (const m of room.members) {
          await client.query(
            `INSERT INTO contact_message_facts (room_hash, ghost_id, network, display_name, phone, from_them, from_me, first_seen, last_seen, run_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (room_hash, ghost_id) DO UPDATE SET network = EXCLUDED.network, display_name = EXCLUDED.display_name,
               phone = EXCLUDED.phone, from_them = EXCLUDED.from_them, from_me = EXCLUDED.from_me,
               first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen, run_id = EXCLUDED.run_id`,
            [room.roomHash, m.ghostId, room.network, m.displayName ?? null, m.phone ?? null, m.fromThem, m.fromMe, m.firstSeen ?? null, m.lastSeen ?? null, runId]);
        }
        await client.query('INSERT INTO contact_export_rooms (run_id, room_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING', [runId, room.roomHash]);
      }
      await client.query(
        'UPDATE contact_export_runs SET rooms_done = (SELECT count(*) FROM contact_export_rooms WHERE run_id = $1), updated_at = now() WHERE run_id = $1', [runId]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finish(runId: string, status: 'done' | 'failed', errorKind?: string) {
    const r = await this.pool.query(
      `UPDATE contact_export_runs SET status = $2, error_kind = $3, finished_at = now(), updated_at = now()
       WHERE run_id = $1 AND status IN ('requested','running')`, [runId, status, errorKind ?? null]);
    return (r.rowCount ?? 0) > 0;
  }

  async countFacts() {
    return Number((await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM contact_message_facts')).rows[0]!.n);
  }
}
