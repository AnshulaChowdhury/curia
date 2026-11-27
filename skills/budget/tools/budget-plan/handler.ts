// skills/budget/tools/budget-plan/handler.ts
//
// The budget month by month, for the budget specialist (ADR-062). Read-only.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { monthOf } from '../../../../src/budget/month.js';

export class BudgetPlanHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.budgetReader;
    if (!reader) return { success: false, error: 'budget-plan requires budgetReader capability' };
    const from = monthOf(ctx.input['from'], ctx.timezone ?? 'UTC');
    if (!from) return { success: false, error: 'from must be YYYY-MM' };
    const months = typeof ctx.input['months'] === 'number' ? ctx.input['months'] : undefined;
    try {
      return { success: true, data: await reader.plan(from, months) };
    } catch (err) {
      ctx.log.error({ err }, 'budget-plan failed');
      return { success: false, error: 'The budget could not be read just now' };
    }
  }
}
