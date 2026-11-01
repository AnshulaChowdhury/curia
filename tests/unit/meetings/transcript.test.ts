import { describe, expect, it } from 'vitest';
import type { VoiceSessionRecord } from '../../../src/channels/voice/session-store.js';
import type { TranscriptSourceRow } from '../../../src/memory/working-memory.js';
import { buildTranscriptDoc, callerSpokeAfter, transcriptPath } from '../../../src/meetings/transcript.js';
import type { SessionAgendaLoad } from '../../../src/meetings/types.js';

const LOADED_AT = new Date('2026-10-28T16:00:00.000Z');

function row(overrides: Partial<TranscriptSourceRow> & Pick<TranscriptSourceRow, 'role' | 'content' | 'createdAt'>): TranscriptSourceRow {
  return {
    senderContactId: null,
    synthetic: false,
    archived: false,
    ...overrides,
  };
}

function session(): VoiceSessionRecord {
  return {
    id: 'sess-1',
    conversationId: 'voice:sess-1',
    livekitRoom: 'room',
    callerContactId: '33333333-3333-3333-3333-333333333333',
    status: 'ended',
    startedAt: new Date('2026-10-28T15:59:00.000Z'),
    endedAt: new Date('2026-10-28T16:10:00.000Z'),
    endReason: 'remote_hangup',
    metadata: {},
  };
}

const load: SessionAgendaLoad = {
  agendaId: '11111111-1111-1111-1111-111111111111',
  loadedAt: LOADED_AT.toISOString(),
  snapshot: {
    agendaId: '11111111-1111-1111-1111-111111111111',
    title: 'Board',
    topics: ['runway'],
    role: null,
    context: 'Cover runway.',
    source: 'principal',
    sensitivity: 'internal',
    scheduledFor: null,
    history: [],
  },
};

describe('buildTranscriptDoc', () => {
  it('drops summary, system and synthetic rows but keeps archived user and assistant rows', () => {
    const doc = buildTranscriptDoc({
      session: session(),
      loads: [load],
      callerName: 'Ada',
      rows: [
        row({ role: 'system', content: '[Conversation summary]\nEarlier.', createdAt: new Date('2026-10-28T15:50:00.000Z') }),
        row({ role: 'user', content: 'Greeting cue', synthetic: true, createdAt: new Date('2026-10-28T15:59:01.000Z') }),
        row({ role: 'user', content: 'Let us start.', archived: true, createdAt: new Date('2026-10-28T16:01:00.000Z') }),
        row({ role: 'assistant', content: 'On runway.', archived: true, createdAt: new Date('2026-10-28T16:02:00.000Z') }),
      ],
    });
    expect(doc.body).toBe('**Ada:** Let us start.\n\n**Curia:** On runway.');
    expect(doc.turnCount).toBe(2);
    expect(doc.body).not.toContain('Conversation summary');
    expect(doc.body).not.toContain('Greeting cue');
  });

  it('frontmatter carries ttl_days 14 and the agenda loads', () => {
    const doc = buildTranscriptDoc({
      session: session(),
      loads: [load],
      callerName: 'Ada',
      rows: [],
    });
    expect(doc.frontmatter.ttl_days).toBe(14);
    expect(doc.frontmatter.agendas).toEqual([{ agenda_id: load.agendaId, loaded_at: load.loadedAt }]);
    expect(doc.frontmatter.notes).toContain('persistence time');
    expect(transcriptPath('sess-1')).toBe('/scratch/meeting-sess-1/transcript.md');
  });

  it('callerSpokeAfter is false when the only user rows predate the load', () => {
    const rows = [
      row({ role: 'user', content: 'Before.', createdAt: new Date(LOADED_AT.getTime() - 1) }),
      row({ role: 'assistant', content: 'After.', createdAt: new Date(LOADED_AT.getTime() + 1) }),
    ];
    expect(callerSpokeAfter(rows, LOADED_AT)).toBe(false);
    rows.push(row({ role: 'user', content: 'Now.', createdAt: LOADED_AT }));
    expect(callerSpokeAfter(rows, LOADED_AT)).toBe(true);
  });
});
