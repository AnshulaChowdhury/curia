// skills/budget/tools/budget-needs-review/handler.ts
//
// Personal transactions waiting for the owner (ADR-062). Read-only.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

export class BudgetNeedsReviewHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.budgetReader;
    if (!reader) return { success: false, error: 'budget-needs-review requires budgetReader capability' };
    try {
      const limit = typeof ctx.input['limit'] === 'number' ? ctx.input['limit'] : undefined;
      return { success: true, data: await reader.needsReview(limit) };
    } catch (err) {
      ctx.log.error({ err }, 'budget-needs-review failed');
      return { success: false, error: 'The budget could not be read just now' };
    }
  }
}
