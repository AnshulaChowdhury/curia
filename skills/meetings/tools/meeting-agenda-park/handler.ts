// handler.ts — meeting-agenda-park (#2322).
//
// The validated way to queue an agenda. Free-form doc-write is not the parking
// path: nothing there checks the schema, the expiry, or the context cap.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { AgendaStore } from '../../../../src/meetings/agenda-store.js';
import { validateParkAgendaInput } from '../../../../src/meetings/agenda-validation.js';
import { formatDisplayTimezone, toLocalIso } from '../../../../src/time/timestamp.js';

export class MeetingAgendaParkHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.workingDocs) {
      return { success: false, error: 'meeting-agenda-park requires the workingDocs capability' };
    }
    const validated = validateParkAgendaInput(ctx.input, new Date());
    if (!validated.ok) return { success: false, error: validated.error };
    try {
      const store = new AgendaStore(ctx.workingDocs, ctx.log);
      const parked = await store.park(validated.value, new Date());
      const tz = ctx.timezone;
      const expiresUnix = Math.floor(Date.parse(parked.expiresAt) / 1000);
      return {
        success: true,
        data: {
          agenda_id: parked.agendaId,
          path: parked.path,
          expires_at: tz
            ? (toLocalIso(Number.isFinite(expiresUnix) ? expiresUnix : null, tz) ?? parked.expiresAt)
            : parked.expiresAt,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'meeting-agenda-park failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
