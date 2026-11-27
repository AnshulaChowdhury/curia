// budget-proposals.ts — the owner's answer to budget changes proposed in a chat (ADR-067).
//
//   GET  /api/budget/proposals?conversationId=…  — the proposal waiting in that chat, or null
//   POST /api/budget/proposals/:id/apply         — {conversationId}: make every change, or none
//   POST /api/budget/proposals/:id/discard       — {conversationId}: drop it
//
// Every route needs the signed-in owner. This is the only way a proposal is applied: no agent or tool can reach it.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import { BudgetError } from '../../../budget/budget-store.js';
import type { ProposalStore } from '../../../budget/proposal-store.js';
import { isConversationId } from '../../../budget/sheet-store.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';

export interface BudgetProposalRouteOptions {
  logger: Logger;
  proposals: Pick<ProposalStore, 'pending' | 'apply' | 'discard'>;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

export async function budgetProposalRoutes(app: FastifyInstance, options: BudgetProposalRouteOptions): Promise<void> {
  const { logger, proposals, webAppBootstrapSecret, sessions } = options;
  const RATE = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const owner = (request: Parameters<typeof assertSecret>[0], reply: FastifyReply): boolean => assertSecret(request, reply, webAppBootstrapSecret, sessions);
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BudgetError) {
      return reply.status(err.kind === 'not_found' ? 404 : err.kind === 'conflict' ? 409 : 400).send({ error: err.message });
    }
    logger.error({ err }, 'budget proposals: call failed');
    return reply.status(500).send({ error: 'Internal error' });
  };

  app.get<{ Querystring: { conversationId?: string } }>('/api/budget/proposals', RATE, async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const id = request.query.conversationId;
    if (!isConversationId(id)) return reply.status(400).send({ error: 'conversationId is required' });
    try {
      return noStore(reply).send({ proposal: await proposals.pending(id) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  for (const action of ['apply', 'discard'] as const) {
    app.post<{ Params: { id: string }; Body: { conversationId?: unknown } | undefined }>(`/api/budget/proposals/:id/${action}`, RATE, async (request, reply) => {
      if (!owner(request, reply)) return reply;
      const conversationId = request.body?.conversationId;
      if (!isUuid(request.params.id) || !isConversationId(conversationId)) return reply.status(400).send({ error: 'A proposal id and conversationId are required' });
      try {
        if (action === 'discard') {
          await proposals.discard(request.params.id, conversationId);
          return noStore(reply).send({ ok: true });
        }
        const done = await proposals.apply(request.params.id, conversationId);
        logger.info(done, 'budget proposal applied by the owner');
        return noStore(reply).send({ ok: true, ...done });
      } catch (err) {
        return fail(reply, err);
      }
    });
  }
}
