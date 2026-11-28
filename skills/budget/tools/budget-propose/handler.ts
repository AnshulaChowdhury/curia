// skills/budget/tools/budget-propose/handler.ts
//
// Puts proposed category changes in front of the owner, in the web chat they asked from (ADR-067). It writes a proposal
// and nothing else: only the owner's console can apply one. The chat is taken from the delegation record that only
// `delegate` writes, never from the model's input.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { delegationOriginChannelId, delegationOriginConversationId } from '../../../../src/agents/delegated-task-context.js';
import { BudgetError } from '../../../../src/budget/budget-store.js';
import { projectionForAgent } from '../../../../src/budget/budget-reader.js';

export const AWAITING = 'NOTHING HAS CHANGED YET. A card in the chat shows these changes. They happen only if the owner replies "yes" or presses Apply there.';

export class BudgetProposeHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const proposer = ctx.budgetProposer;
    if (!proposer) return { success: false, error: 'budget-propose requires budgetProposer capability' };
    const conversationId = delegationOriginConversationId(ctx.taskMetadata);
    if (ctx.channelId !== 'internal' || !conversationId || delegationOriginChannelId(ctx.taskMetadata) !== 'web') {
      return { success: false, error: 'Budget changes can only be proposed when the owner asks from the web chat' };
    }
    try {
      const proposal = await proposer.propose(conversationId, ctx.input['categories'], ctx.input['months']);
      const count = (action: string) => proposal.rows.filter(r => r.action === action).length;
      return {
        success: true,
        data: {
          proposed: true, status: AWAITING, toCreate: count('create'), toUpdate: count('update'), toArchive: count('archive'),
          // Where net worth would head if the owner approved this as it is. The card shows it, updated as they edit.
          ...(proposal.projection ? { netWorthIfApproved: projectionForAgent(proposal.projection) } : {}),
        },
      };
    } catch (err) {
      if (err instanceof BudgetError) return { success: false, error: err.message };
      ctx.log.error({ err }, 'budget-propose failed');
      return { success: false, error: 'The proposal could not be saved just now' };
    }
  }
}
