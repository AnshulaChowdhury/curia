import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { MeetingNotesStartHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function ctx(voiceSessionId?: string): ToolContext {
  return {
    input: {},
    log: silentLog,
    agentId: 'coordinator',
    taskMetadata: voiceSessionId ? { voiceSessionId } : undefined,
  } as unknown as ToolContext;
}

describe('meeting-notes-start', () => {
  it('turns notes on for a live voice session', async () => {
    const result = await new MeetingNotesStartHandler().execute(ctx('session-1'));
    expect(result).toEqual({ success: true, data: { notes_on: true } });
  });

  it('rejects outside a voice session', async () => {
    const result = await new MeetingNotesStartHandler().execute(ctx());
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('meeting-notes-start is only available on a live voice call');
  });
});
