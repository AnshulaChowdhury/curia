// skills/budget/tools/budget-summary/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BudgetSummaryHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const ctx = (over: Partial<ToolContext>): ToolContext =>
  ({ input: {}, secret: () => { throw new Error('no secrets'); }, log: createSilentLogger(), timezone: 'America/Toronto', ...over }) as ToolContext;

describe('budget-summary', () => {
  it('fails closed without the budgetReader capability', async () => {
    const r = await new BudgetSummaryHandler().execute(ctx({}));
    expect(r).toEqual({ success: false, error: expect.stringContaining('budgetReader') });
  });

  it('returns what the reader gives', async () => {
    const reader = { summary: vi.fn().mockResolvedValue({ ok: 1 }) };
    const r = await new BudgetSummaryHandler().execute(ctx({ budgetReader: reader as never }));
    expect(r.success).toBe(true);
    expect(reader.summary).toHaveBeenCalledOnce();
  });

  it('turns a failure into a plain error without leaking the cause', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('db password=hunter2'));
    const r = await new BudgetSummaryHandler().execute(ctx({ budgetReader: { summary: boom, needsReview: boom, transactions: boom } as never }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('refuses a malformed month before reading anything', async () => {
    const reader = { summary: vi.fn(), transactions: vi.fn() };
    const r = await new BudgetSummaryHandler().execute(ctx({ budgetReader: reader as never, input: { month: 'March' } }));
    expect(r).toEqual({ success: false, error: 'month must be YYYY-MM' });
    expect(reader.summary).not.toHaveBeenCalled();
    expect(reader.transactions).not.toHaveBeenCalled();
  });
});
