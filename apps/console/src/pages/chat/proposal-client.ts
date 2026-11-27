// The owner-only /api/budget/proposals routes: changes the assistant proposed in this chat, waiting for a yes.

import { apiFetch } from '../../api.js';
import type { CategoryKind } from '../budget-utils.js';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export interface ProposedRow {
  action: 'create' | 'update' | 'archive';
  name: string;
  renameFrom?: string;
  kind: CategoryKind;
  previousKind?: CategoryKind;
  amounts: Array<{ month: string; cents: number | null; was: number | null }>;
}
export interface Proposal { id: string; rows: ProposedRow[]; expiresAt: string }
export interface Applied { created: number; updated: number; archived: number }

export function createProposalClient(f: Fetcher = apiFetch) {
  async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const res = await f(path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const reply = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(typeof reply?.error === 'string' ? reply.error : 'Something went wrong.');
    }
    return (await res.json()) as T;
  }
  const one = (id: string) => `/api/budget/proposals/${encodeURIComponent(id)}`;
  return {
    pending: async (conversationId: string) =>
      (await call<{ proposal: Proposal | null }>(`/api/budget/proposals?conversationId=${encodeURIComponent(conversationId)}`)).proposal,
    /** One edited amount; null clears it. Returns the proposal as now stored. */
    setAmount: async (id: string, conversationId: string, name: string, month: string, cents: number | null) =>
      (await call<{ proposal: Proposal }>(one(id), { conversationId, name, month, cents }, 'PATCH')).proposal,
    apply: (id: string, conversationId: string) => call<Applied>(`${one(id)}/apply`, { conversationId }),
    discard: async (id: string, conversationId: string) => { await call(`${one(id)}/discard`, { conversationId }); },
  };
}

export const proposalClient = createProposalClient();
