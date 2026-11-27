// The proposal waiting in this chat. Looked up when the chat opens and after each reply, which is when one can appear.

import { useCallback, useEffect, useRef, useState } from 'react';
import { proposalClient, type Proposal } from './proposal-client.js';

/** A message that approves the proposal on screen: just "yes" (or "apply"), nothing more. */
export const isApproval = (text: string): boolean => /^\s*(yes|apply)\s*[.!]*\s*$/i.test(text);

export function useBudgetProposal(conversationId: string | null, replying: boolean) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Edits are saved one after another, and applying waits for them: false once one has failed.
  const saving = useRef<Promise<boolean>>(Promise.resolve(true));
  // Cells holding something that is not an amount.
  const unreadable = useRef(new Set<string>());
  const [invalid, setInvalid] = useState(false);

  const look = useCallback(async () => {
    if (!conversationId) return;
    try {
      const found = await proposalClient.pending(conversationId);
      setProposal(found);
      if (found) setOutcome(null);
      else { unreadable.current.clear(); setInvalid(false); }
    } catch (err) {
      // Not the owner, or the budget is unreachable: there is simply no card.
      console.error('budget proposal lookup failed', err);
    }
  }, [conversationId]);
  useEffect(() => { if (!replying) void look(); }, [replying, look]);

  function edit(name: string, month: string, cents: number | null) {
    if (!proposal || !conversationId) return;
    const { id } = proposal;
    saving.current = saving.current.then(async ok => {
      try {
        setProposal(await proposalClient.setAmount(id, conversationId, name, month, cents));
        setError(null);
        return ok;
      } catch (err) {
        console.error('budget proposal edit failed', err);
        setError(`That amount did not save. ${err instanceof Error ? err.message : ''}`);
        await look();
        return false;
      }
    });
  }

  function markCell(cell: string, bad: boolean) {
    if (bad) unreadable.current.add(cell); else unreadable.current.delete(cell);
    setInvalid(unreadable.current.size > 0);
  }

  async function decide(approve: boolean) {
    if (!proposal || !conversationId || busy) return;
    setBusy(true); setError(null);
    const saved = await saving.current;
    saving.current = Promise.resolve(true);
    // Never apply figures other than the ones on screen.
    if (approve && (!saved || unreadable.current.size > 0)) {
      setError(saved ? 'Fix the highlighted amount first. Nothing was applied.' : 'An edit did not save, so nothing was applied. Check the amounts and apply again.');
      setBusy(false);
      return;
    }
    try {
      if (approve) {
        const done = await proposalClient.apply(proposal.id, conversationId);
        setOutcome(`Applied: ${done.created} created, ${done.updated} updated, ${done.archived} archived.`);
      } else {
        await proposalClient.discard(proposal.id, conversationId);
        setOutcome('Discarded. Nothing changed.');
      }
      setProposal(null);
      unreadable.current.clear();
      setInvalid(false);
    } catch (err) {
      console.error('budget proposal decision failed', err);
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      await look();
    }
    setBusy(false);
  }

  return { proposal, outcome, error, busy, invalid, edit, markCell, apply: () => decide(true), discard: () => decide(false), dismiss: () => { setOutcome(null); setError(null); } };
}
