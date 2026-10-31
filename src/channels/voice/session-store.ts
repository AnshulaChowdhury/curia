import type { Pool } from 'pg';
import type { AgendaSnapshot, SessionAgendaLoad } from '../../meetings/types.js';
import { AGENDA_SENSITIVITIES, AGENDA_SOURCES, TOPIC_COVERAGE } from '../../meetings/types.js';

export type VoiceSessionStatus = 'starting' | 'active' | 'ended' | 'failed';

export interface VoiceSessionRecord {
  id: string;
  conversationId: string;
  livekitRoom: string;
  callerContactId: string | null;
  status: VoiceSessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  metadata: Record<string, unknown>;
}

interface VoiceSessionRow {
  id: string;
  conversation_id: string;
  livekit_room: string;
  caller_contact_id: string | null;
  status: VoiceSessionStatus;
  started_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateVoiceSessionInput {
  id?: string;
  conversationId: string;
  livekitRoom: string;
  callerContactId?: string;
  metadata?: Record<string, unknown>;
}

export class VoiceSessionStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateVoiceSessionInput): Promise<VoiceSessionRecord> {
    const result = await this.pool.query<VoiceSessionRow>(
      `INSERT INTO voice_sessions (id, conversation_id, livekit_room, caller_contact_id, status, metadata)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'starting', $5::jsonb)
       RETURNING id, conversation_id, livekit_room, caller_contact_id, status, started_at, ended_at, end_reason, metadata`,
      [
        input.id ?? null,
        input.conversationId,
        input.livekitRoom,
        input.callerContactId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapRow(requireSingleRow(result.rows));
  }

  async get(id: string): Promise<VoiceSessionRecord | null> {
    const result = await this.pool.query<VoiceSessionRow>(
      `SELECT id, conversation_id, livekit_room, caller_contact_id, status, started_at, ended_at, end_reason, metadata
       FROM voice_sessions
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async updateStatus(id: string, status: Exclude<VoiceSessionStatus, 'ended'>): Promise<VoiceSessionRecord | null> {
    const result = await this.pool.query<VoiceSessionRow>(
      `UPDATE voice_sessions
       SET status = $2
       WHERE id = $1 AND status <> 'ended'
       RETURNING id, conversation_id, livekit_room, caller_contact_id, status, started_at, ended_at, end_reason, metadata`,
      [id, status],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async endSession(id: string, reason: string): Promise<VoiceSessionRecord | null> {
    const result = await this.pool.query<VoiceSessionRow>(
      `UPDATE voice_sessions
       SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), end_reason = $2
       WHERE id = $1 AND status <> 'ended'
       RETURNING id, conversation_id, livekit_room, caller_contact_id, status, started_at, ended_at, end_reason, metadata`,
      [id, reason],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Append one agenda load to `metadata.agendas`. Other metadata keys are left
   * in place. A missing session throws so the caller can log it.
   */
  async appendAgendaLoad(id: string, load: SessionAgendaLoad): Promise<void> {
    const result = await this.pool.query(
      `UPDATE voice_sessions
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{agendas}',
           CASE
             WHEN jsonb_typeof(metadata->'agendas') = 'array' THEN metadata->'agendas'
             ELSE '[]'::jsonb
           END || $2::jsonb
         )
       WHERE id = $1`,
      [id, JSON.stringify([load])],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`voice session ${id} not found for agenda load`);
    }
  }

  /**
   * Record that the caller asked for notes, and whether they want a recap (#2347).
   * The first request's time is kept, and a recap once asked for stays asked for.
   *
   * Only a live session takes the mark. endSession's update and this one serialize
   * on the row, so the mark either commits before the session ends (and the
   * pipeline, which runs after the end, sees it) or finds the session ended and
   * throws. A mark can never land after the pipeline has read the session.
   */
  async markNotesRequested(id: string, requestedAt: Date, recap: boolean): Promise<{ requestedAt: string; recap: boolean }> {
    const result = await this.pool.query<{ notes: { requestedAt: string; recap: boolean } }>(
      `UPDATE voice_sessions
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{notes}',
           jsonb_build_object(
             'requestedAt', COALESCE(metadata->'notes'->>'requestedAt', $2::text),
             'recap', COALESCE((metadata->'notes'->>'recap')::boolean, false) OR $3::boolean
           )
         )
       WHERE id = $1 AND status IN ('starting', 'active')
       RETURNING metadata->'notes' AS notes`,
      [id, requestedAt.toISOString(), recap],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`voice session ${id} is not live; notes not started`);
    return row.notes;
  }

  /**
   * Ended or failed sessions since `since` that recorded an agenda load or a
   * notes request. Used by the startup sweep.
   */
  async listRecentForMinutes(since: Date): Promise<VoiceSessionRecord[]> {
    const result = await this.pool.query<VoiceSessionRow>(
      `SELECT id, conversation_id, livekit_room, caller_contact_id, status, started_at, ended_at, end_reason, metadata
         FROM voice_sessions
        WHERE status IN ('ended', 'failed')
          AND started_at >= $1
          AND (
            (jsonb_typeof(COALESCE(metadata->'agendas', '[]'::jsonb)) = 'array'
              AND jsonb_array_length(COALESCE(metadata->'agendas', '[]'::jsonb)) > 0)
            OR jsonb_typeof(metadata->'notes') = 'object'
          )
        ORDER BY started_at ASC`,
      [since],
    );
    return result.rows.map(mapRow);
  }

  async markAbandonedOnRestart(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE voice_sessions
       SET status = 'failed', ended_at = COALESCE(ended_at, NOW()), end_reason = 'process_restart'
       WHERE status IN ('starting', 'active')`,
    );
    return result.rowCount ?? 0;
  }
}

function isSnapshot(value: unknown): value is AgendaSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.agendaId !== 'string' || typeof record.title !== 'string') return false;
  if (typeof record.context !== 'string') return false;
  if (!Array.isArray(record.topics) || !record.topics.every((topic) => typeof topic === 'string')) return false;
  if (typeof record.source !== 'string' || !AGENDA_SOURCES.includes(record.source as AgendaSnapshot['source'])) return false;
  if (typeof record.sensitivity !== 'string' || !AGENDA_SENSITIVITIES.includes(record.sensitivity as AgendaSnapshot['sensitivity'])) {
    return false;
  }
  if (record.role !== null && typeof record.role !== 'string') return false;
  if (record.scheduledFor !== null && typeof record.scheduledFor !== 'string') return false;
  if (!Array.isArray(record.history)) return false;
  return record.history.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const row = entry as Record<string, unknown>;
    if (typeof row.sessionId !== 'string' || typeof row.date !== 'string' || !Array.isArray(row.topics)) return false;
    return row.topics.every((topic) => {
      if (!topic || typeof topic !== 'object') return false;
      const item = topic as Record<string, unknown>;
      return typeof item.topic === 'string'
        && typeof item.coverage === 'string'
        && TOPIC_COVERAGE.includes(item.coverage as AgendaSnapshot['history'][number]['topics'][number]['coverage']);
    });
  });
}

/** Read `metadata.agendas`, dropping entries that are not a complete load. No log. */
export function sessionAgendaLoads(record: VoiceSessionRecord): SessionAgendaLoad[] {
  const raw = record.metadata.agendas;
  if (!Array.isArray(raw)) return [];
  const loads: SessionAgendaLoad[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.agendaId !== 'string' || typeof row.loadedAt !== 'string') continue;
    if (!isSnapshot(row.snapshot)) continue;
    if (row.snapshot.agendaId !== row.agendaId) continue;
    loads.push({ agendaId: row.agendaId, loadedAt: row.loadedAt, snapshot: row.snapshot });
  }
  return loads;
}

/** Read `metadata.notes`. Null when the caller never asked for notes or the entry is malformed. */
export function sessionNotesRequest(record: VoiceSessionRecord): { requestedAt: string; recap: boolean } | null {
  const raw = record.metadata.notes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { requestedAt, recap } = raw as Record<string, unknown>;
  return typeof requestedAt === 'string' ? { requestedAt, recap: recap === true } : null;
}

function requireSingleRow(rows: VoiceSessionRow[]): VoiceSessionRow {
  const row = rows[0];
  if (!row) throw new Error('voice_sessions write returned no row');
  return row;
}

function mapRow(row: VoiceSessionRow): VoiceSessionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    livekitRoom: row.livekit_room,
    callerContactId: row.caller_contact_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    metadata: row.metadata,
  };
}
