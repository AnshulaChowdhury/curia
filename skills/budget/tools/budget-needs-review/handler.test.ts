// skills/budget/tools/budget-needs-review/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BudgetNeedsReviewHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const ctx = (over: Partial<ToolContext>): ToolContext =>
  ({ input: {}, secret: () => { throw new Error('no secrets'); }, log: createSilentLogger(), timezone: 'America/Toronto', ...over }) as ToolContext;

describe('budget-needs-review', () => {
  it('fails closed without the budgetReader capability', async () => {
    const r = await new BudgetNeedsReviewHandler().execute(ctx({}));
    expect(r).toEqual({ success: false, error: expect.stringContaining('budgetReader') });
  });

  it('returns what the reader gives', async () => {
    const reader = { needsReview: vi.fn().mockResolvedValue({ transactions: [] }) };
    const r = await new BudgetNeedsReviewHandler().execute(ctx({ budgetReader: reader as never }));
    expect(r.success).toBe(true);
    expect(reader.needsReview).toHaveBeenCalledOnce();
  });

  it('turns a failure into a plain error without leaking the cause', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('db password=hunter2'));
    const r = await new BudgetNeedsReviewHandler().execute(ctx({ budgetReader: { summary: boom, needsReview: boom, transactions: boom } as never }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});
