import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MeetingNotesStartHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function ctx(opts: {
  voiceSessionId?: string;
  input?: Record<string, unknown>;
  mark?: (id: string, at: Date, recap: boolean) => Promise<{ requestedAt: string; recap: boolean }>;
}): ToolContext {
  return {
    input: opts.input ?? { recap: true },
    log: silentLog,
    agentId: 'coordinator',
    taskMetadata: opts.voiceSessionId ? { voiceSessionId: opts.voiceSessionId } : undefined,
    voiceSessions: opts.mark ? { markNotesRequested: opts.mark } : undefined,
  } as unknown as ToolContext;
}

describe('meeting-notes-start', () => {
  it('writes the mark and reports what was stored', async () => {
    const mark = vi.fn(async (_id: string, at: Date, recap: boolean) => ({ requestedAt: at.toISOString(), recap }));
    const result = await new MeetingNotesStartHandler().execute(ctx({ voiceSessionId: 'session-1', input: { recap: false }, mark }));
    expect(result).toEqual({ success: true, data: { notes_on: true, recap: false } });
    expect(mark).toHaveBeenCalledWith('session-1', expect.any(Date), false);
  });

  it('reports the stored recap, which a notes-only call cannot turn off', async () => {
    const mark = vi.fn(async () => ({ requestedAt: '2026-10-29T15:46:00.000Z', recap: true }));
    const result = await new MeetingNotesStartHandler().execute(ctx({ voiceSessionId: 'session-1', input: { recap: false }, mark }));
    expect(result).toEqual({ success: true, data: { notes_on: true, recap: true } });
  });

  // The audit log records this result, so a failed write must be a failed result (#2347).
  it('fails when the mark cannot be written', async () => {
    const mark = vi.fn(async () => {
      throw new Error('voice session session-1 is not live; notes not started');
    });
    const result = await new MeetingNotesStartHandler().execute(ctx({ voiceSessionId: 'session-1', mark }));
    expect(result).toEqual({ success: false, error: 'Notes could not be started for this call.' });
  });

  it('requires recap as a boolean', async () => {
    const mark = vi.fn();
    const result = await new MeetingNotesStartHandler().execute(ctx({ voiceSessionId: 'session-1', input: {}, mark }));
    expect(result.success).toBe(false);
    expect(mark).not.toHaveBeenCalled();
  });

  it('rejects outside a voice session', async () => {
    const result = await new MeetingNotesStartHandler().execute(ctx({ mark: vi.fn() }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('meeting-notes-start is only available on a live voice call');
  });
});
