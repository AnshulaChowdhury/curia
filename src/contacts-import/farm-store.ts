// farm-store.ts — the interim contact facts and scan progress (tables contact_farm_*, migration 120). Counts only; no
// message content. One progress write and its fact increments happen in a single transaction, so a scan that stops
// mid-page and resumes never counts a page twice.

import type { Pool } from 'pg';
import type { FarmDelta } from './farm-reduce.js';

export type FarmStatus = 'running' | 'paused' | 'done' | 'failed';

export interface FarmRun {
  accountId: string;
  status: FarmStatus;
  windowStart: string;
  cursor: string | null;
  messagesScanned: number;
  pagesScanned: number;
  errorKind: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface FarmFact {
  email: string;
  domain: string;
  displayName: string | null;
  received: number;
  sent: number;
  copied: number;
  firstSeen: string;
  lastSeen: string;
}

export interface FarmFactRow extends FarmFact { accountId: string }

export interface FarmStore {
  /** Every mailbox's facts, for cross-mailbox grouping (organisations). */
  allFacts(limit: number): Promise<FarmFactRow[]>;
  getRun(accountId: string): Promise<FarmRun | null>;
  /** Starts a fresh scan (clears that mailbox's old facts) or, with resume, keeps the cursor and counts. */
  startRun(accountId: string, windowStart: Date, resume: boolean): Promise<FarmRun>;
  /** Adds a page's counts and moves the cursor, atomically. */
  commitPage(accountId: string, cursor: string | null, messages: number, deltas: FarmDelta[]): Promise<void>;
  finish(accountId: string, status: 'done' | 'paused' | 'failed', errorKind?: string): Promise<void>;
  facts(accountId: string, limit: number): Promise<FarmFact[]>;
  countFacts(accountId: string): Promise<number>;
}

const iso = (sec: number): string => new Date(sec * 1000).toISOString();

export class InMemoryFarmStore implements FarmStore {
  readonly runs = new Map<string, FarmRun>();
  readonly rows = new Map<string, FarmFact>();

  async getRun(accountId: string): Promise<FarmRun | null> {
    return this.runs.get(accountId) ?? null;
  }

  async startRun(accountId: string, windowStart: Date, resume: boolean): Promise<FarmRun> {
    const old = this.runs.get(accountId);
    const now = new Date().toISOString();
    if (resume && old && old.status !== 'done') {
      const run = { ...old, status: 'running' as const, errorKind: null, updatedAt: now, finishedAt: null };
      this.runs.set(accountId, run);
      return run;
    }
    for (const k of [...this.rows.keys()]) if (k.startsWith(`${accountId}\u0000`)) this.rows.delete(k);
    const run: FarmRun = { accountId, status: 'running', windowStart: windowStart.toISOString(), cursor: null, messagesScanned: 0, pagesScanned: 0, errorKind: null, startedAt: now, updatedAt: now, finishedAt: null };
    this.runs.set(accountId, run);
    return run;
  }

  async commitPage(accountId: string, cursor: string | null, messages: number, deltas: FarmDelta[]): Promise<void> {
    const run = this.runs.get(accountId)!;
    for (const d of deltas) {
      const key = `${accountId}\u0000${d.email}`;
      const cur = this.rows.get(key);
      this.rows.set(key, {
        email: d.email, domain: d.domain,
        displayName: (d.name?.length ?? 0) > (cur?.displayName?.length ?? 0) ? d.name! : (cur?.displayName ?? null),
        received: (cur?.received ?? 0) + d.received, sent: (cur?.sent ?? 0) + d.sent, copied: (cur?.copied ?? 0) + d.copied,
        firstSeen: cur && d.first > 0 ? (cur.firstSeen < iso(d.first) ? cur.firstSeen : iso(d.first)) : iso(d.first),
        lastSeen: cur && cur.lastSeen > iso(d.last) ? cur.lastSeen : iso(d.last),
      });
    }
    this.runs.set(accountId, { ...run, cursor, messagesScanned: run.messagesScanned + messages, pagesScanned: run.pagesScanned + 1, updatedAt: new Date().toISOString() });
  }

  async finish(accountId: string, status: 'done' | 'paused' | 'failed', errorKind?: string): Promise<void> {
    const run = this.runs.get(accountId);
    if (!run) return;
    const now = new Date().toISOString();
    this.runs.set(accountId, { ...run, status, errorKind: errorKind ?? null, updatedAt: now, finishedAt: status === 'done' ? now : null });
  }

  async allFacts(limit: number): Promise<FarmFactRow[]> {
    return [...this.rows.entries()].map(([k, v]) => ({ ...v, accountId: k.split('\u0000')[0]! })).slice(0, limit);
  }

  async facts(accountId: string, limit: number): Promise<FarmFact[]> {
    return [...this.rows.entries()].filter(([k]) => k.startsWith(`${accountId}\u0000`)).map(([, v]) => v).slice(0, limit);
  }

  async countFacts(accountId: string): Promise<number> {
    return (await this.facts(accountId, Number.MAX_SAFE_INTEGER)).length;
  }
}

interface RunRow {
  account_id: string; status: FarmStatus; window_start: Date; cursor: string | null; messages_scanned: string;
  pages_scanned: number; error_kind: string | null; started_at: Date; updated_at: Date; finished_at: Date | null;
}
const toRun = (r: RunRow): FarmRun => ({
  accountId: r.account_id, status: r.status, windowStart: r.window_start.toISOString(), cursor: r.cursor,
  messagesScanned: Number(r.messages_scanned), pagesScanned: r.pages_scanned, errorKind: r.error_kind,
  startedAt: r.started_at.toISOString(), updatedAt: r.updated_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
});

export class PgFarmStore implements FarmStore {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

  async getRun(accountId: string): Promise<FarmRun | null> {
    const r = await this.pool.query<RunRow>('SELECT * FROM contact_farm_runs WHERE account_id = $1', [accountId]);
    return r.rows[0] ? toRun(r.rows[0]) : null;
  }

  async startRun(accountId: string, windowStart: Date, resume: boolean): Promise<FarmRun> {
    const old = await this.getRun(accountId);
    if (resume && old && old.status !== 'done') {
      const r = await this.pool.query<RunRow>(
        `UPDATE contact_farm_runs SET status = 'running', error_kind = NULL, finished_at = NULL, updated_at = now()
         WHERE account_id = $1 RETURNING *`, [accountId]);
      return toRun(r.rows[0]!);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM contact_farm_facts WHERE account_id = $1', [accountId]);
      const r = await client.query<RunRow>(
        `INSERT INTO contact_farm_runs (account_id, status, window_start) VALUES ($1, 'running', $2)
         ON CONFLICT (account_id) DO UPDATE SET status = 'running', window_start = EXCLUDED.window_start, cursor = NULL,
           messages_scanned = 0, pages_scanned = 0, error_kind = NULL, started_at = now(), updated_at = now(), finished_at = NULL
         RETURNING *`, [accountId, windowStart]);
      await client.query('COMMIT');
      return toRun(r.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async commitPage(accountId: string, cursor: string | null, messages: number, deltas: FarmDelta[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const d of deltas) {
        await client.query(
          `INSERT INTO contact_farm_facts (account_id, email, domain, display_name, received, sent, copied, first_seen, last_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),to_timestamp($9))
           ON CONFLICT (account_id, email) DO UPDATE SET
             received = contact_farm_facts.received + EXCLUDED.received,
             sent = contact_farm_facts.sent + EXCLUDED.sent,
             copied = contact_farm_facts.copied + EXCLUDED.copied,
             first_seen = LEAST(contact_farm_facts.first_seen, EXCLUDED.first_seen),
             last_seen = GREATEST(contact_farm_facts.last_seen, EXCLUDED.last_seen),
             display_name = CASE WHEN length(COALESCE(EXCLUDED.display_name, '')) > length(COALESCE(contact_farm_facts.display_name, ''))
                                 THEN EXCLUDED.display_name ELSE contact_farm_facts.display_name END`,
          [accountId, d.email, d.domain, d.name ?? null, d.received, d.sent, d.copied, d.first, d.last]);
      }
      await client.query(
        `UPDATE contact_farm_runs SET cursor = $2, messages_scanned = messages_scanned + $3, pages_scanned = pages_scanned + 1, updated_at = now()
         WHERE account_id = $1`, [accountId, cursor, messages]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finish(accountId: string, status: 'done' | 'paused' | 'failed', errorKind?: string): Promise<void> {
    await this.pool.query(
      `UPDATE contact_farm_runs SET status = $2, error_kind = $3, updated_at = now(),
         finished_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END WHERE account_id = $1`,
      [accountId, status, errorKind ?? null]);
  }

  async allFacts(limit: number): Promise<FarmFactRow[]> {
    const r = await this.pool.query<{ account_id: string; email: string; domain: string; display_name: string | null; received: number; sent: number; copied: number; first_seen: Date; last_seen: Date }>(
      'SELECT * FROM contact_farm_facts ORDER BY (received + sent) DESC, email LIMIT $1', [limit]);
    return r.rows.map((x) => ({ accountId: x.account_id, email: x.email, domain: x.domain, displayName: x.display_name, received: x.received, sent: x.sent, copied: x.copied, firstSeen: x.first_seen.toISOString(), lastSeen: x.last_seen.toISOString() }));
  }

  async facts(accountId: string, limit: number): Promise<FarmFact[]> {
    const r = await this.pool.query<{ email: string; domain: string; display_name: string | null; received: number; sent: number; copied: number; first_seen: Date; last_seen: Date }>(
      'SELECT * FROM contact_farm_facts WHERE account_id = $1 ORDER BY (received + sent) DESC, email LIMIT $2', [accountId, limit]);
    return r.rows.map((x) => ({ email: x.email, domain: x.domain, displayName: x.display_name, received: x.received, sent: x.sent, copied: x.copied, firstSeen: x.first_seen.toISOString(), lastSeen: x.last_seen.toISOString() }));
  }

  async countFacts(accountId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM contact_farm_facts WHERE account_id = $1', [accountId]);
    return Number(r.rows[0]!.n);
  }
}
