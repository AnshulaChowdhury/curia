// handler.ts — meeting-agenda-load (#2322).
//
// Voice-only, like async-offramp. The coordinator is the caller because the
// voice bridge invokes tools as the coordinator; the voiceSessionId guard is
// the real gate. Loading locks the agenda for this session. It does not
// consume it — settlement after the call decides that.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { AgendaStore, type AgendaLockResult } from '../../src/meetings/agenda-store.js';
import { agendaSnapshot } from '../../src/meetings/agenda-store.js';

function spokenLockError(reason: Extract<AgendaLockResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'expired':
      return 'That agenda has expired.';
    case 'not_pending':
      return 'That agenda is not available to load.';
    case 'not_found':
      return 'I cannot find that agenda.';
    case 'conflict':
      return 'That agenda is already in use on another call.';
    default: {
      const neverReason: never = reason;
      return `Could not load that agenda (${neverReason}).`;
    }
  }
}

export class MeetingAgendaLoadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const sessionId = ctx.taskMetadata?.voiceSessionId;
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { success: false, error: 'meeting-agenda-load is only available on a live voice call' };
    }
    if (!ctx.workingDocs) {
      return { success: false, error: 'meeting-agenda-load requires the workingDocs capability' };
    }
    const agendaId = typeof ctx.input.agenda_id === 'string' ? ctx.input.agenda_id.trim() : '';
    if (!agendaId) return { success: false, error: 'agenda_id is required' };
    try {
      const store = new AgendaStore(ctx.workingDocs, ctx.log);
      const locked = await store.lock(agendaId, sessionId, new Date());
      if (!locked.ok) return { success: false, error: spokenLockError(locked.reason) };
      return { success: true, data: { agenda: agendaSnapshot(locked.agenda) } };
    } catch (err) {
      ctx.log.error({ err, agendaId }, 'meeting-agenda-load failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
