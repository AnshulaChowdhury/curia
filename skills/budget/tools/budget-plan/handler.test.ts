// skills/budget/tools/budget-plan/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BudgetPlanHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const ctx = (input: Record<string, unknown>, plan = vi.fn().mockResolvedValue({ months: [] })) =>
  ({ input, log: createSilentLogger(), timezone: 'America/Toronto', budgetReader: { plan } }) as unknown as ToolContext;

describe('budget-plan', () => {
  it('fails closed without the budgetReader capability', async () => {
    const r = await new BudgetPlanHandler().execute({ input: {}, log: createSilentLogger() } as unknown as ToolContext);
    expect(r).toEqual({ success: false, error: expect.stringContaining('budgetReader') });
  });

  it('passes the months asked for, and refuses a malformed one', async () => {
    const plan = vi.fn().mockResolvedValue({ months: [] });
    await new BudgetPlanHandler().execute(ctx({ from: '2031-03', months: 12 }, plan));
    expect(plan).toHaveBeenCalledWith('2031-03', 12);
    expect((await new BudgetPlanHandler().execute(ctx({ from: 'March' }))).success).toBe(false);
  });
});
