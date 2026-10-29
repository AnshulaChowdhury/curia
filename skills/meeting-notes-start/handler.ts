// handler.ts — meeting-notes-start (#2347).
//
// Voice-only, like meeting-agenda-load. The handler only checks that a live
// call is asking. The voice runtime records the request on the session, the
// way it records an agenda load, and turns this result into an error when
// that write fails, so the call never promises a recap nobody will send.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

export class MeetingNotesStartHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const sessionId = ctx.taskMetadata?.voiceSessionId;
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { success: false, error: 'meeting-notes-start is only available on a live voice call' };
    }
    return { success: true, data: { notes_on: true } };
  }
}
