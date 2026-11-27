// skills/budget/tools/budget-sheet-read/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BudgetSheetReadHandler } from './handler.js';
import { BudgetError } from '../../../../src/budget/budget-store.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const origin = (channelId: string) => ({ delegationOrigin: { conversationId: 'chat-1', channelId, agentId: 'coordinator' } });
const ctx = (over: Partial<ToolContext>): ToolContext =>
  ({ input: {}, secret: () => { throw new Error('no secrets'); }, log: createSilentLogger(), timezone: 'America/Toronto', channelId: 'internal', taskMetadata: origin('web'), ...over }) as ToolContext;
const page = { sheet: 'Budget', savedAt: '2031-03-02T12:00:00.000Z', tabs: ['Plan'], tab: 'Plan', cells: [], nextRow: null, warnings: [] };
const run = (over: Partial<ToolContext>, read = vi.fn().mockResolvedValue(page)) =>
  new BudgetSheetReadHandler().execute(ctx({ budgetSheetReader: { read } as never, ...over })).then(result => ({ result, read }));

describe('budget-sheet-read', () => {
  it('fails closed without the budgetSheetReader capability', async () => {
    const r = await new BudgetSheetReadHandler().execute(ctx({}));
    expect(r).toEqual({ success: false, error: expect.stringContaining('budgetSheetReader') });
  });

  it('reads the chat the delegation came from, whatever the input says', async () => {
    const { result, read } = await run({ input: { tab: 'Plan', startRow: 3, conversationId: 'chat-9', id: 'x' } });
    expect(read).toHaveBeenCalledWith('chat-1', { tab: 'Plan', startRow: 3 });
    expect(result).toMatchObject({ success: true, data: { attached: true, tab: 'Plan', savedAt: '2031-03-02T07:00:00.000-05:00' } });
  });

  it('refuses anything but a delegated request from the web chat, without reading', async () => {
    for (const over of [
      { taskMetadata: origin('signal') }, { taskMetadata: origin('email') }, { taskMetadata: undefined },
      { channelId: 'scheduler' }, { channelId: 'web' },
    ]) {
      const { result, read } = await run(over);
      expect(result.success).toBe(false);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('says when nothing is attached', async () => {
    const { result } = await run({}, vi.fn().mockResolvedValue(null));
    expect(result).toEqual({ success: true, data: { attached: false } });
  });

  it('passes on a plain refusal but not the cause of a failure', async () => {
    const refused = await run({}, vi.fn().mockRejectedValue(new BudgetError('No visible tab by that name. Tabs: Plan')));
    expect(refused.result).toEqual({ success: false, error: 'No visible tab by that name. Tabs: Plan' });
    const broke = await run({}, vi.fn().mockRejectedValue(new Error('db password=hunter2')));
    expect(JSON.stringify(broke.result)).not.toContain('hunter2');
  });
});
