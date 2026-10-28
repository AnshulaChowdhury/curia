import { describe, expect, it } from 'vitest';
import { formatAgendaPromptBlock, parseAgendaLoadResult } from '../../../src/meetings/agenda-prompt.js';
import type { AgendaSnapshot } from '../../../src/meetings/types.js';

function snapshot(overrides: Partial<AgendaSnapshot> = {}): AgendaSnapshot {
  return {
    agendaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Q3 review',
    topics: ['Pipeline', 'Hiring'],
    role: 'Be brief.',
    context: 'Board wants a status.',
    source: 'principal',
    sensitivity: 'internal',
    scheduledFor: null,
    history: [],
    ...overrides,
  };
}

describe('formatAgendaPromptBlock', () => {
  it('returns null for no loaded and no index', () => {
    expect(formatAgendaPromptBlock({ loaded: [], index: [] })).toBeNull();
  });

  it('renders a loaded agenda with topics, role and remaining-topics history', () => {
    const block = formatAgendaPromptBlock({
      loaded: [snapshot({
        history: [{
          sessionId: 's1',
          date: '2026-10-21T15:00:00.000Z',
          topics: [
            { topic: 'Pipeline', coverage: 'covered' },
            { topic: 'Hiring', coverage: 'not_reached' },
          ],
        }],
      })],
      index: [],
    });
    expect(block).toContain('Q3 review');
    expect(block).toContain('1. Pipeline');
    expect(block).toContain('2. Hiring');
    expect(block).toContain('Role: Be brief.');
    expect(block).toContain('Board wants a status.');
    expect(block).toContain('Left from earlier calls: Hiring (not_reached)');
    expect(block).not.toContain('Pipeline (covered)');
  });

  it('renders an index with load instructions', () => {
    const block = formatAgendaPromptBlock({
      loaded: [],
      index: [{ agendaId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Friday sync', scheduledFor: null }],
    });
    expect(block).toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(block).toContain('Friday sync');
    expect(block).toContain('no time set');
    expect(block).toContain('meeting-agenda-load');
    expect(block).toContain('Ask the caller if you are unsure');
  });
});

describe('parseAgendaLoadResult', () => {
  it('returns null for an error result or bad JSON', () => {
    expect(parseAgendaLoadResult('That agenda has expired.')).toBeNull();
    expect(parseAgendaLoadResult('{')).toBeNull();
    expect(parseAgendaLoadResult(JSON.stringify({ error: 'nope' }))).toBeNull();
  });

  it('returns the agenda from a successful tool envelope', () => {
    const agenda = snapshot();
    expect(parseAgendaLoadResult(JSON.stringify({ agenda }))).toEqual(agenda);
  });
});
