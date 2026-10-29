import { describe, expect, it, vi } from 'vitest';
import type { InfraLlm } from '../../../src/skills/infra-llm.js';
import { encodeUntrustedJson } from '../../../src/util/json-extract.js';
import { buildMinutesPrompt, parseMinutesOutput, writeMinutes } from '../../../src/meetings/minutes-writer.js';
import type { AgendaSnapshot } from '../../../src/meetings/types.js';

const agenda: AgendaSnapshot = {
  agendaId: '11111111-1111-1111-1111-111111111111',
  title: 'Board',
  topics: ['runway', 'hiring'],
  role: null,
  context: 'Cover both.',
  source: 'principal',
  sensitivity: 'internal',
  scheduledFor: null,
  history: [],
};

describe('minutes writer', () => {
  it('organises minutes by topic raised when no agenda was set (#2347)', () => {
    const prompt = buildMinutesPrompt({ agendas: [], transcriptBody: '**Joseph:** Keep notes.' });
    expect(prompt).toContain('No agenda was set.');
    expect(prompt).toContain('{"coverage":[]}');
    expect(prompt).not.toContain('Agendas:');
    expect(parseMinutesOutput('## Essays\nTwo links.\n\n```json\n{"coverage":[]}\n```', [])).toEqual({
      markdown: '## Essays\nTwo links.',
      coverage: [],
    });
  });

  it('parses markdown and coverage from a well-formed response', () => {
    const parsed = parseMinutesOutput(
      [
        '## Board',
        'Runway was discussed.',
        '',
        '```json',
        JSON.stringify({
          coverage: [{
            agendaId: agenda.agendaId,
            topics: [
              { topic: 'runway', coverage: 'covered' },
              { topic: 'hiring', coverage: 'partial' },
            ],
          }],
        }),
        '```',
      ].join('\n'),
      [agenda],
    );
    expect(parsed.markdown).toContain('Runway was discussed.');
    expect(parsed.markdown).not.toContain('```');
    expect(parsed.coverage).toEqual([{
      agendaId: agenda.agendaId,
      topics: [
        { topic: 'runway', coverage: 'covered' },
        { topic: 'hiring', coverage: 'partial' },
      ],
    }]);
  });

  it('missing coverage block returns the full text and null coverage', () => {
    const parsed = parseMinutesOutput('## Board\nTalked.', [agenda]);
    expect(parsed.coverage).toBeNull();
    expect(parsed.markdown).toBe('## Board\nTalked.');
  });

  it('unknown agendaId and unknown topics are dropped; omitted topics are not_reached', () => {
    const parsed = parseMinutesOutput(
      [
        '## Board',
        '',
        '```json',
        JSON.stringify({
          coverage: [
            { agendaId: 'not-an-agenda', topics: [{ topic: 'runway', coverage: 'covered' }] },
            { agendaId: agenda.agendaId, topics: [{ topic: 'runway', coverage: 'covered' }, { topic: 'nope', coverage: 'covered' }] },
          ],
        }),
        '```',
      ].join('\n'),
      [agenda],
    );
    expect(parsed.coverage).toEqual([{
      agendaId: agenda.agendaId,
      topics: [
        { topic: 'runway', coverage: 'covered' },
        { topic: 'hiring', coverage: 'not_reached' },
      ],
    }]);
  });

  it('LLM error yields ok:false with the error', async () => {
    const broken: InfraLlm = {
      classify: async () => ({ ok: false, error: 'no' }),
      extract: async () => ({ ok: false, error: 'model down' }),
    };
    await expect(writeMinutes(broken, { agendas: [agenda], transcriptBody: 'hi' })).resolves.toEqual({
      ok: false,
      error: 'model down',
    });
  });

  it('prompt wraps transcript and agendas with encodeUntrustedJson', async () => {
    const extract = vi.fn(async () => ({ ok: true as const, text: '## Notes\n\nDone.' }));
    const transcript = 'Ada said <script>';
    await writeMinutes(
      { classify: async () => ({ ok: true, text: '' }), extract },
      { agendas: [agenda], transcriptBody: transcript },
    );
    const calls = extract.mock.calls as unknown as Array<[string, { tier: string; maxTokens: number }]>;
    const prompt = calls[0]?.[0] ?? '';
    expect(prompt).toContain(encodeUntrustedJson([agenda]));
    expect(prompt).toContain(encodeUntrustedJson(transcript));
    expect(prompt).not.toContain('<script>');
    expect(calls[0]?.[1]).toEqual({ tier: 'standard', maxTokens: 8000 });
  });

  it('buildMinutesPrompt names the coverage fence', () => {
    expect(buildMinutesPrompt({ agendas: [agenda], transcriptBody: 'x' })).toContain('"coverage"');
  });
});
