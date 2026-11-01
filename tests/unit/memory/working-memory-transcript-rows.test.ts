import { describe, expect, it } from 'vitest';
import { WorkingMemory } from '../../../src/memory/working-memory.js';

describe('WorkingMemory.getTranscriptRows', () => {
  it('returns system and synthetic rows in created_at order', async () => {
    const memory = WorkingMemory.createInMemory();
    const conversationId = 'voice:transcript-order';
    await memory.addTurn(conversationId, 'coordinator', { role: 'user', content: 'second' }, {
      createdAt: new Date('2026-10-28T16:02:00.000Z'),
    });
    await memory.addTurn(conversationId, 'coordinator', { role: 'system', content: '[Conversation summary]\nfirst' }, {
      createdAt: new Date('2026-10-28T16:00:00.000Z'),
      synthetic: true,
    });
    await memory.addTurn(conversationId, 'coordinator', { role: 'assistant', content: 'third' }, {
      createdAt: new Date('2026-10-28T16:03:00.000Z'),
    });

    const rows = await memory.getTranscriptRows(conversationId, 'coordinator');
    expect(rows.map((row) => row.content)).toEqual([
      '[Conversation summary]\nfirst',
      'second',
      'third',
    ]);
    expect(rows[0]?.synthetic).toBe(true);
    expect(rows[0]?.role).toBe('system');
  });
});
