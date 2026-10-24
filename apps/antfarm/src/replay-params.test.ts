import { describe, expect, it } from 'vitest';
import { readReplayParams } from './replay-params.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');

describe('readReplayParams', () => {
  it('reads a conversation window from the URL', () => {
    const p = readReplayParams('?conversationId=conv-1&from=2026-10-24T09:00:00.000Z&to=2026-10-24T09:30:00.000Z', NOW);
    expect(p).toEqual({
      from: new Date('2026-10-24T09:00:00.000Z'),
      to: new Date('2026-10-24T09:30:00.000Z'),
      conversationId: 'conv-1',
    });
  });

  it('falls back to the last 24h when the window is missing or invalid', () => {
    for (const search of ['', '?from=nope&to=2026-10-24T09:30:00.000Z', '?from=2026-10-24T10:00:00Z&to=2026-10-24T09:00:00Z']) {
      const p = readReplayParams(search, NOW);
      expect(p.to).toEqual(NOW);
      expect(p.from).toEqual(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
    }
  });

  it('keeps the conversation filter with the default window', () => {
    expect(readReplayParams('?conversationId=conv-2', NOW).conversationId).toBe('conv-2');
  });
});
