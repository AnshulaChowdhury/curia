// skills/budget/tools/budget-net-worth/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BudgetNetWorthHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const ctx = (netWorth: unknown, input: Record<string, unknown> = {}) =>
  ({ input, log: createSilentLogger(), budgetReader: { netWorth } }) as unknown as ToolContext;

describe('budget-net-worth', () => {
  it('fails closed without the budgetReader capability', async () => {
    const r = await new BudgetNetWorthHandler().execute({ input: {}, log: createSilentLogger() } as unknown as ToolContext);
    expect(r).toEqual({ success: false, error: expect.stringContaining('budgetReader') });
  });

  it('passes the number of months on', async () => {
    const netWorth = vi.fn().mockResolvedValue({ months: [] });
    expect(await new BudgetNetWorthHandler().execute(ctx(netWorth, { months: 12 }))).toEqual({ success: true, data: { months: [] } });
    expect(netWorth).toHaveBeenCalledWith(12);
  });

  it('does not pass on the cause of a failure', async () => {
    const r = await new BudgetNetWorthHandler().execute(ctx(vi.fn().mockRejectedValue(new Error('password=hunter2'))));
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});
