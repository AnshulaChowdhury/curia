// skills/budget/tools/budget-transactions/handler.ts
//
// One month of personal transactions, optionally for one category (ADR-062). Read-only.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { monthOf } from '../../../../src/budget/month.js';

export class BudgetTransactionsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.budgetReader;
    if (!reader) return { success: false, error: 'budget-transactions requires budgetReader capability' };
    const month = monthOf(ctx.input['month'], ctx.timezone ?? 'UTC');
    if (!month) return { success: false, error: 'month must be YYYY-MM' };
    const category = typeof ctx.input['category'] === 'string' ? ctx.input['category'].slice(0, 60) : undefined;
    const limit = typeof ctx.input['limit'] === 'number' ? ctx.input['limit'] : undefined;
    try {
      return { success: true, data: await reader.transactions({ month, category, limit }) };
    } catch (err) {
      ctx.log.error({ err }, 'budget-transactions failed');
      return { success: false, error: 'The budget could not be read just now' };
    }
  }
}
