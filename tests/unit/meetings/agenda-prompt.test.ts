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
    expect(block).toContain('background material from parked sources');
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

  // #2347: the caller heard "loading the agenda". The block may name the tool and
  // quote the banned words, but no instruction may use them as the spoken verb.
  it('never uses load as the verb outside the tool name and the quoted ban', () => {
    const block = formatAgendaPromptBlock({
      loaded: [snapshot()],
      index: [{ agendaId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Friday sync', scheduledFor: null }],
    }) ?? '';
    expect(block).toContain('let me pull that up');
    const prose = block.replaceAll('meeting-agenda-load', '').replace(/"load(ing)?"/g, '');
    expect(prose).not.toMatch(/\bload(s|ed|ing)?\b/i);
  });

  it('renders the notes block alone when notes are on and no agenda exists', () => {
    const block = formatAgendaPromptBlock({ loaded: [], index: [], notesOn: true });
    expect(block).toContain('## Meeting notes');
    expect(block).toContain('Do not hand the recap off');
    expect(block).not.toContain('## Meeting agendas');
  });

  it('renders a scheduled time in the principal timezone', () => {
    const block = formatAgendaPromptBlock({
      loaded: [],
      index: [{
        agendaId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        title: 'Friday sync',
        scheduledFor: '2026-10-28T16:00:00.000Z',
      }],
    }, 'America/Toronto');
    expect(block).toContain('2026-10-28T12:00:00.000-04:00');
    expect(block).not.toContain('2026-10-28T16:00:00.000Z');
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
