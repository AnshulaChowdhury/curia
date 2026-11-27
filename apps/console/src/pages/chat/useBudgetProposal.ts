// The proposal waiting in this chat. Looked up when the chat opens and after each reply, which is when one can appear.

import { useCallback, useEffect, useState } from 'react';
import { proposalClient, type Proposal } from './proposal-client.js';

/** A message that approves the proposal on screen: just "yes" (or "apply"), nothing more. */
export const isApproval = (text: string): boolean => /^\s*(yes|apply)\s*[.!]*\s*$/i.test(text);

export function useBudgetProposal(conversationId: string | null, replying: boolean) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = useCallback(async () => {
    if (!conversationId) return;
    try {
      const found = await proposalClient.pending(conversationId);
      setProposal(found);
      if (found) setOutcome(null);
    } catch (err) {
      // Not the owner, or the budget is unreachable: there is simply no card.
      console.error('budget proposal lookup failed', err);
    }
  }, [conversationId]);
  useEffect(() => { if (!replying) void look(); }, [replying, look]);

  async function decide(approve: boolean) {
    if (!proposal || !conversationId || busy) return;
    setBusy(true); setError(null);
    try {
      if (approve) {
        const done = await proposalClient.apply(proposal.id, conversationId);
        setOutcome(`Applied: ${done.created} created, ${done.updated} updated, ${done.archived} archived.`);
      } else {
        await proposalClient.discard(proposal.id, conversationId);
        setOutcome('Discarded. Nothing changed.');
      }
      setProposal(null);
    } catch (err) {
      console.error('budget proposal decision failed', err);
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      await look();
    }
    setBusy(false);
  }

  return { proposal, outcome, error, busy, apply: () => decide(true), discard: () => decide(false), dismiss: () => { setOutcome(null); setError(null); } };
}
