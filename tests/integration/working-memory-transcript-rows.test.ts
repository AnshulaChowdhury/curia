import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createLogger } from '../../src/logger.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const CONVERSATION = 'meetings-2322:transcript-rows';

describeIf('WorkingMemory.getTranscriptRows (Postgres, #2322)', () => {
  let pool: pg.Pool;
  let memory: WorkingMemory;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    memory = WorkingMemory.createWithPostgres(pool, createLogger('error'));
    await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [CONVERSATION]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [CONVERSATION]);
    await pool.end();
  });

  it('returns archived rows and the summary row in created_at order', async () => {
    await pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content, created_at, archived, synthetic)
       VALUES ($1, 'coordinator', 'user', 'archived caller', '2026-10-28T16:00:00Z', true, false),
              ($1, 'coordinator', 'system', E'[Conversation summary]\\ncondensed', '2026-10-28T16:01:00Z', false, true)`,
      [CONVERSATION],
    );
    await memory.addTurn(CONVERSATION, 'coordinator', { role: 'assistant', content: 'live reply' }, {
      createdAt: new Date('2026-10-28T16:02:00.000Z'),
    });

    const rows = await memory.getTranscriptRows(CONVERSATION, 'coordinator');
    expect(rows.map((row) => row.content)).toEqual([
      'archived caller',
      '[Conversation summary]\ncondensed',
      'live reply',
    ]);
    expect(rows[0]?.archived).toBe(true);
    expect(rows[1]?.role).toBe('system');
  });
});
