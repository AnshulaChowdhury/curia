// skills/budget/tools/budget-summary/handler.ts
//
// The budget specialist's month overview (ADR-062). Read-only: BudgetReader has no method that changes anything.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { monthOf } from '../../../../src/budget/month.js';

export class BudgetSummaryHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.budgetReader;
    if (!reader) return { success: false, error: 'budget-summary requires budgetReader capability' };
    const month = monthOf(ctx.input['month'], ctx.timezone ?? 'UTC');
    if (!month) return { success: false, error: 'month must be YYYY-MM' };
    try {
      return { success: true, data: await reader.summary(month) };
    } catch (err) {
      ctx.log.error({ err }, 'budget-summary failed');
      return { success: false, error: 'The budget could not be read just now' };
    }
  }
}
