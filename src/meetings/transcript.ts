// transcript.ts — a call transcript from raw working-memory rows (#2322).
//
// Keeps user rows that are not synthetic, and assistant rows. Summary, system,
// and greeting-cue rows are dropped. Archived rows are kept: the transcript is
// the call, not the live context window.

import type { VoiceSessionRecord } from '../channels/voice/session-store.js';
import type { TranscriptSourceRow } from '../memory/working-memory.js';
import type { SessionAgendaLoad } from './types.js';

export function transcriptPath(sessionId: string): string {
  return `/scratch/meeting-${sessionId}/transcript.md`;
}

/** True when a real caller turn was stored at or after `at`. */
export function callerSpokeAfter(rows: TranscriptSourceRow[], at: Date): boolean {
  const atMs = at.getTime();
  return rows.some((row) =>
    row.role === 'user' && !row.synthetic && row.createdAt.getTime() >= atMs,
  );
}

function kept(row: TranscriptSourceRow): boolean {
  if (row.role === 'assistant') return true;
  return row.role === 'user' && !row.synthetic;
}

export function buildTranscriptDoc(input: {
  session: VoiceSessionRecord;
  loads: SessionAgendaLoad[];
  rows: TranscriptSourceRow[];
  callerName: string;
}): { frontmatter: Record<string, unknown>; body: string; turnCount: number } {
  const turns = input.rows.filter(kept);
  const body = turns
    .map((row) => `**${row.role === 'assistant' ? 'Curia' : input.callerName}:** ${row.content}`)
    .join('\n\n');
  return {
    turnCount: turns.length,
    body,
    frontmatter: {
      session_id: input.session.id,
      conversation_id: input.session.conversationId,
      participants: [
        { contact_id: input.session.callerContactId, name: input.callerName },
        { contact_id: null, name: 'Curia' },
      ],
      agendas: input.loads.map((load) => ({ agenda_id: load.agendaId, loaded_at: load.loadedAt })),
      started_at: input.session.startedAt.toISOString(),
      ended_at: input.session.endedAt?.toISOString() ?? null,
      end_reason: input.session.endReason,
      turn_count: turns.length,
      ttl_days: 14,
      notes: 'Turns are persisted best-effort; timestamps are persistence time, not speech time.',
    },
  };
}
