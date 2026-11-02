// brief-store.ts — Postgres storage for the morning brief: one row per local date.

import type { DbPool } from '../db/connection.js';
import type { Brief, BriefSection, BriefStore } from './types.js';

// A brief older than this is pruned on the next save; the phone only ever asks for today's.
const KEEP_DAYS = 30;

interface Row {
  brief_date: string;
  generated_at: Date;
  payload: { sections?: BriefSection[] };
}

export class PgBriefStore implements BriefStore {
  constructor(private readonly pool: DbPool) {}

  async save(brief: Brief): Promise<void> {
    await this.pool.query(
      `INSERT INTO phone_briefs (brief_date, generated_at, payload) VALUES ($1, $2, $3)
       ON CONFLICT (brief_date) DO UPDATE SET generated_at = EXCLUDED.generated_at, payload = EXCLUDED.payload`,
      [brief.date, brief.generatedAt, JSON.stringify({ sections: brief.sections })],
    );
    await this.pool.query(`DELETE FROM phone_briefs WHERE brief_date < ($1::date - $2::int)`, [brief.date, KEEP_DAYS]);
  }

  async get(date: string): Promise<Brief | null> {
    // to_char keeps the date as the local YYYY-MM-DD string the contract uses, with no timezone conversion.
    const result = await this.pool.query<Row>(
      `SELECT to_char(brief_date, 'YYYY-MM-DD') AS brief_date, generated_at, payload FROM phone_briefs WHERE brief_date = $1`,
      [date],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { date: row.brief_date, generatedAt: row.generated_at.toISOString(), sections: row.payload.sections ?? [] };
  }
}
