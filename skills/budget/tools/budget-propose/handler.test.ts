// skills/budget/tools/budget-propose/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BudgetProposeHandler } from './handler.js';
import { BudgetError } from '../../../../src/budget/budget-store.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const origin = (channelId: string) => ({ delegationOrigin: { conversationId: 'chat-1', channelId, agentId: 'coordinator' } });
const proposal = { id: 'p', rows: [{ action: 'create' }, { action: 'create' }, { action: 'update' }] };
const run = async (over: Partial<ToolContext>, propose = vi.fn().mockResolvedValue(proposal)) => {
  const ctx = { input: { months: ['2031-03'], categories: [{ name: 'Rent' }], conversationId: 'chat-9' }, log: createSilentLogger(), channelId: 'internal', taskMetadata: origin('web'), budgetProposer: { propose }, ...over } as unknown as ToolContext;
  return { result: await new BudgetProposeHandler().execute(ctx), propose };
};

describe('budget-propose', () => {
  it('fails closed without the budgetProposer capability', async () => {
    expect((await run({ budgetProposer: undefined })).result).toEqual({ success: false, error: expect.stringContaining('budgetProposer') });
  });

  it('proposes into the chat the delegation came from, and says nothing has changed', async () => {
    const { result, propose } = await run({});
    expect(propose).toHaveBeenCalledWith('chat-1', [{ name: 'Rent' }], ['2031-03']);
    expect(result).toMatchObject({ success: true, data: { proposed: true, status: expect.stringContaining('NOTHING HAS CHANGED YET'), toCreate: 2, toUpdate: 1, toArchive: 0 } });
  });

  it('refuses anything but a delegated request from the web chat', async () => {
    for (const over of [{ taskMetadata: origin('signal') }, { taskMetadata: origin('email') }, { taskMetadata: undefined }, { channelId: 'scheduler' }, { channelId: 'web' }]) {
      const { result, propose } = await run(over);
      expect(result.success).toBe(false);
      expect(propose).not.toHaveBeenCalled();
    }
  });

  it('passes on a plain refusal but not the cause of a failure', async () => {
    expect((await run({}, vi.fn().mockRejectedValue(new BudgetError('Give at least one category')))).result).toEqual({ success: false, error: 'Give at least one category' });
    expect(JSON.stringify((await run({}, vi.fn().mockRejectedValue(new Error('password=hunter2')))).result)).not.toContain('hunter2');
  });
});
