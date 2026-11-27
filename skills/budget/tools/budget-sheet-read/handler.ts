// skills/budget/tools/budget-sheet-read/handler.ts
//
// Reads the spreadsheet attached to the web chat the owner asked from (ADR-065). Read-only. The chat is taken from the
// delegation record that only `delegate` writes, never from the model's input.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { delegationOriginChannelId, delegationOriginConversationId } from '../../../../src/agents/delegated-task-context.js';
import { BudgetError } from '../../../../src/budget/budget-store.js';
import { toLocalIso } from '../../../../src/time/timestamp.js';

export class BudgetSheetReadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.budgetSheetReader;
    if (!reader) return { success: false, error: 'budget-sheet-read requires budgetSheetReader capability' };
    // A delegated run is on the internal channel; a scheduled or woken run is not, whatever its metadata says.
    const conversationId = delegationOriginConversationId(ctx.taskMetadata);
    if (ctx.channelId !== 'internal' || !conversationId || delegationOriginChannelId(ctx.taskMetadata) !== 'web') {
      return { success: false, error: 'A spreadsheet can only be read when the owner asks from the web chat it is attached to' };
    }
    const tab = typeof ctx.input['tab'] === 'string' ? ctx.input['tab'] : undefined;
    const startRow = typeof ctx.input['startRow'] === 'number' ? ctx.input['startRow'] : undefined;
    try {
      const page = await reader.read(conversationId, { tab, startRow });
      if (!page) return { success: true, data: { attached: false } };
      return { success: true, data: { attached: true, ...page, savedAt: toLocalIso(Math.floor(Date.parse(page.savedAt) / 1000), ctx.timezone ?? 'UTC') } };
    } catch (err) {
      if (err instanceof BudgetError) return { success: false, error: err.message };
      ctx.log.error({ err }, 'budget-sheet-read failed');
      return { success: false, error: 'The spreadsheet could not be read just now' };
    }
  }
}
