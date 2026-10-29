// Integration tests for VoiceSessionStore — requires Postgres with migration 089 applied.
// Skips gracefully when DATABASE_URL is unset. CI boots Postgres, migrates, and sets it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { VoiceSessionStore, sessionAgendaLoads, sessionNotesRequest } from '../../src/channels/voice/session-store.js';
import type { AgendaSnapshot, SessionAgendaLoad } from '../../src/meetings/types.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'voice-store-test:';

async function seedContact(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO contacts (display_name) VALUES ($1) RETURNING id`,
    [`${PREFIX}contact`],
  );
  const row = rows[0];
  if (!row) throw new Error('seedContact: INSERT INTO contacts returned no rows');
  return row.id;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM voice_sessions WHERE conversation_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM contacts WHERE display_name LIKE $1`, [`${PREFIX}%`]);
}

describeIf('VoiceSessionStore (integration)', () => {
  let pool: pg.Pool;
  let store: VoiceSessionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Fails loudly if migration 082/089 is missing — the column name is the thing under test.
    await pool.query('SELECT caller_contact_id FROM voice_sessions LIMIT 0');
    store = new VoiceSessionStore(pool);
  });

  afterAll(async () => {
    try {
      await cleanup(pool);
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  it('create round-trips a real caller contact id', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}round-trip`,
      livekitRoom: 'room-round-trip',
      callerContactId: contactId,
    });
    expect(created.callerContactId).toBe(contactId);
    expect(created.status).toBe('starting');
  });

  it('create stores null when callerContactId is omitted', async () => {
    const created = await store.create({
      conversationId: `${PREFIX}null-caller`,
      livekitRoom: 'room-null-caller',
    });
    expect(created.callerContactId).toBeNull();
  });

  it('get reads the persisted caller contact id', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}get`,
      livekitRoom: 'room-get',
      callerContactId: contactId,
    });
    const fetched = await store.get(created.id);
    expect(fetched?.callerContactId).toBe(contactId);
    expect(fetched?.conversationId).toBe(`${PREFIX}get`);
  });

  it('updateStatus returns the caller contact id from its own RETURNING list', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}status`,
      livekitRoom: 'room-status',
      callerContactId: contactId,
    });
    const updated = await store.updateStatus(created.id, 'active');
    expect(updated?.status).toBe('active');
    expect(updated?.callerContactId).toBe(contactId);
  });

  it('endSession returns the caller contact id from its own RETURNING list', async () => {
    const contactId = await seedContact(pool);
    const created = await store.create({
      conversationId: `${PREFIX}end`,
      livekitRoom: 'room-end',
      callerContactId: contactId,
    });
    const ended = await store.endSession(created.id, 'hangup');
    expect(ended?.status).toBe('ended');
    expect(ended?.endReason).toBe('hangup');
    expect(ended?.callerContactId).toBe(contactId);
    expect(ended?.endedAt).toBeInstanceOf(Date);
  });

  it('names the caller foreign key caller_contact_id and keeps ON DELETE SET NULL', async () => {
    const { rows } = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
       FROM pg_constraint
       WHERE conrelid = 'voice_sessions'::regclass
         AND contype = 'f'`,
    );
    const names = rows.map((row) => row.conname);
    expect(names).toContain('voice_sessions_caller_contact_id_fkey');
    expect(names).not.toContain('voice_sessions_principal_contact_id_fkey');
    const fk = rows.find((row) => row.conname === 'voice_sessions_caller_contact_id_fkey');
    expect(fk?.confdeltype).toBe('n');
  });

  function snapshot(agendaId: string): AgendaSnapshot {
    return {
      agendaId,
      title: 'Q3 review',
      topics: ['Pipeline'],
      role: 'Be brief.',
      context: 'Board wants a status.',
      source: 'principal',
      sensitivity: 'internal',
      scheduledFor: null,
      history: [],
    };
  }

  function load(agendaId: string, loadedAt: string): SessionAgendaLoad {
    return { agendaId, loadedAt, snapshot: snapshot(agendaId) };
  }

  it('appendAgendaLoad appends in order and preserves other metadata keys', async () => {
    const created = await store.create({
      conversationId: `${PREFIX}agendas`,
      livekitRoom: 'room-agendas',
      metadata: { channel: 'signal', agendas: [] },
    });
    const first = load('11111111-1111-4111-8111-111111111111', '2026-10-28T16:00:00.000Z');
    const second = load('22222222-2222-4222-8222-222222222222', '2026-10-28T16:05:00.000Z');
    await store.appendAgendaLoad(created.id, first);
    await store.appendAgendaLoad(created.id, second);
    const fetched = await store.get(created.id);
    expect(fetched?.metadata.channel).toBe('signal');
    expect(sessionAgendaLoads(fetched!)).toEqual([first, second]);
  });

  it('listRecentForMinutes returns ended and failed sessions with agendas or a notes request', async () => {
    const since = new Date(Date.now() - 60_000);
    const ended = await store.create({
      conversationId: `${PREFIX}recent-ended`,
      livekitRoom: 'room-recent-ended',
    });
    await store.appendAgendaLoad(ended.id, load('33333333-3333-4333-8333-333333333333', since.toISOString()));
    await store.endSession(ended.id, 'remote_hangup');

    const failed = await store.create({
      conversationId: `${PREFIX}recent-failed`,
      livekitRoom: 'room-recent-failed',
    });
    await store.appendAgendaLoad(failed.id, load('44444444-4444-4444-8444-444444444444', since.toISOString()));
    await pool.query(
      `UPDATE voice_sessions SET status = 'failed', end_reason = 'process_restart', ended_at = NOW() WHERE id = $1`,
      [failed.id],
    );

    const active = await store.create({
      conversationId: `${PREFIX}recent-active`,
      livekitRoom: 'room-recent-active',
    });
    await store.appendAgendaLoad(active.id, load('55555555-5555-4555-8555-555555555555', since.toISOString()));
    await store.updateStatus(active.id, 'active');

    const bare = await store.create({
      conversationId: `${PREFIX}recent-bare`,
      livekitRoom: 'room-recent-bare',
    });
    await store.endSession(bare.id, 'remote_hangup');

    const notes = await store.create({
      conversationId: `${PREFIX}recent-notes`,
      livekitRoom: 'room-recent-notes',
    });
    await store.markNotesRequested(notes.id, new Date());
    await store.endSession(notes.id, 'remote_hangup');

    const old = await store.create({
      conversationId: `${PREFIX}recent-old`,
      livekitRoom: 'room-recent-old',
    });
    await store.appendAgendaLoad(old.id, load('66666666-6666-4666-8666-666666666666', since.toISOString()));
    await store.endSession(old.id, 'remote_hangup');
    await pool.query(
      `UPDATE voice_sessions SET started_at = NOW() - INTERVAL '8 days' WHERE id = $1`,
      [old.id],
    );

    const listed = await store.listRecentForMinutes(since);
    const ids = listed.map((row) => row.id);
    expect(ids).toContain(ended.id);
    expect(ids).toContain(failed.id);
    expect(ids).toContain(notes.id);
    expect(ids).not.toContain(active.id);
    expect(ids).not.toContain(bare.id);
    expect(ids).not.toContain(old.id);
  });

  it('markNotesRequested keeps the first request and other metadata keys (#2347)', async () => {
    const created = await store.create({
      conversationId: `${PREFIX}notes`,
      livekitRoom: 'room-notes',
      metadata: { channel: 'signal' },
    });
    expect(sessionNotesRequest(created)).toBeNull();
    await store.markNotesRequested(created.id, new Date('2026-10-29T15:46:00.000Z'));
    await store.markNotesRequested(created.id, new Date('2026-10-29T15:49:00.000Z'));
    const fetched = await store.get(created.id);
    expect(fetched?.metadata.channel).toBe('signal');
    expect(sessionNotesRequest(fetched!)).toEqual({ requestedAt: '2026-10-29T15:46:00.000Z' });
  });

  it('markNotesRequested throws for a missing session', async () => {
    await expect(store.markNotesRequested('99999999-9999-4999-8999-999999999999', new Date()))
      .rejects.toThrow('not found for notes request');
  });

  it('sessionAgendaLoads ignores malformed entries', async () => {
    const created = await store.create({
      conversationId: `${PREFIX}malformed`,
      livekitRoom: 'room-malformed',
      metadata: {
        agendas: [
          { agendaId: 'not-a-snapshot' },
          { agendaId: '77777777-7777-4777-8777-777777777777', loadedAt: '2026-10-28T16:00:00.000Z', snapshot: { title: 'missing fields' } },
          load('88888888-8888-4888-8888-888888888888', '2026-10-28T16:01:00.000Z'),
        ],
      },
    });
    const fetched = await store.get(created.id);
    const loads = sessionAgendaLoads(fetched!);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.agendaId).toBe('88888888-8888-4888-8888-888888888888');
  });

  it('re-applying the up migration is a no-op', async () => {
    const sql = readFileSync(
      join(import.meta.dirname, '../../src/db/migrations/089_rename_voice_session_caller_contact_id.sql'),
      'utf8',
    );
    const up = sql.split(/^-- Down Migration$/m)[0];
    if (!up?.includes('RENAME COLUMN')) throw new Error('failed to extract the up migration');
    await pool.query(up);
    await pool.query('SELECT caller_contact_id FROM voice_sessions LIMIT 0');
  });
});
