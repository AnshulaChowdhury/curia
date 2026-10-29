// handler.ts — meeting-notes-start (#2347).
//
// Voice-only, like meeting-agenda-load. The handler writes the mark itself, so
// the tool result the audit log records says whether the call is really marked.
// The voice runtime reads that result to restate notes in later turns' prompts.
//
// `recap` keeps "take notes" apart from "send me a recap": both get minutes and
// any directed change, but only an asked-for recap is sent regardless of coverage.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

export class MeetingNotesStartHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const sessionId = ctx.taskMetadata?.voiceSessionId;
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { success: false, error: 'meeting-notes-start is only available on a live voice call' };
    }
    if (typeof ctx.input.recap !== 'boolean') {
      return { success: false, error: 'recap is required: true if the caller asked for a recap after the call, otherwise false' };
    }
    if (!ctx.voiceSessions) {
      return { success: false, error: 'meeting-notes-start requires the voiceSessions capability' };
    }
    try {
      const notes = await ctx.voiceSessions.markNotesRequested(sessionId, new Date(), ctx.input.recap);
      return { success: true, data: { notes_on: true, recap: notes.recap } };
    } catch (err) {
      ctx.log.error({ err, sessionId }, 'meeting-notes-start: failed to record notes request');
      return { success: false, error: 'Notes could not be started for this call.' };
    }
  }
}
