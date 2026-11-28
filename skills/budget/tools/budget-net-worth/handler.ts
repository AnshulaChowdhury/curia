// skills/budget/tools/budget-net-worth/handler.ts
//
// Net worth today and where the budget takes it, for the budget specialist (ADR-062, ADR-069). Read-only; totals only.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

export class BudgetNetWorthHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.budgetReader;
    if (!reader) return { success: false, error: 'budget-net-worth requires budgetReader capability' };
    const months = typeof ctx.input['months'] === 'number' ? ctx.input['months'] : undefined;
    try {
      return { success: true, data: await reader.netWorth(months) };
    } catch (err) {
      ctx.log.error({ err }, 'budget-net-worth failed');
      return { success: false, error: 'Net worth could not be worked out just now' };
    }
  }
}
