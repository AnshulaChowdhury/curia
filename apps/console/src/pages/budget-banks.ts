// Client for the owner-only bank import and bank-feed routes (web_dev PR #93).
// The Plaid access token never reaches the browser: only a short-lived link token goes in, and a one-time public token goes out.
import { apiFetch } from '../api.js';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export type LinkStatus = 'active' | 'needs_login' | 'error';
export interface BankLink {
  id: string;
  institution: string;
  status: LinkStatus;
  lastError: string | null;
  lastSyncedAt: string | null;
  accounts: Array<string | { name?: string; mask?: string }>;
}
export interface BanksState { configured: boolean; links: BankLink[] }
export interface ImportResult { format: string; added: number; duplicates: number; skipped: number }

export class BudgetApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
  get locked(): boolean { return this.status === 401 || this.status === 403; }
}

async function ensure(res: Response): Promise<Response> {
  if (res.ok) return res;
  let message = 'Something went wrong.';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') message = body.error;
  } catch { /* keep the generic message */ }
  throw new BudgetApiError(message, res.status);
}

export const MAX_ACCOUNT_LABEL = 60;

/** Accounts may arrive as strings or objects; show a plain label either way. */
export function accountLabel(a: BankLink['accounts'][number]): string {
  if (typeof a === 'string') return a;
  return [a.name, a.mask ? `…${a.mask}` : ''].filter(Boolean).join(' ');
}

export function statusText(s: LinkStatus): string {
  return s === 'active' ? 'Connected' : s === 'needs_login' ? 'Needs login' : 'Error';
}

export function validateAccount(label: string): string | null {
  const t = label.trim();
  if (!t) return 'Name the account this file belongs to.';
  if (t.length > MAX_ACCOUNT_LABEL) return `Keep it under ${MAX_ACCOUNT_LABEL} characters.`;
  return null;
}

export function createBankClient(f: Fetcher = apiFetch) {
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> => (await ensure(await f(path, init))).json() as Promise<T>;
  const post = (path: string, body?: unknown) => json<Record<string, unknown>>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return {
    async importFile(file: File, account: string): Promise<ImportResult> {
      const q = new URLSearchParams({ name: file.name, account: account.trim() });
      return json<ImportResult>(`/api/budget/imports?${q.toString()}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
    },
    banks: () => json<BanksState>('/api/budget/banks'),
    async linkToken(): Promise<string> { return (await post('/api/budget/banks/link-token'))['linkToken'] as string; },
    connect: (publicToken: string, institution: string) => post('/api/budget/banks', { publicToken, institution }),
    syncAll: () => post('/api/budget/banks/sync'),
    async syncOne(id: string): Promise<number> { return (await post(`/api/budget/banks/${encodeURIComponent(id)}/sync`))['added'] as number; },
    async disconnect(id: string): Promise<void> { await ensure(await f(`/api/budget/banks/${encodeURIComponent(id)}`, { method: 'DELETE' })); },
  };
}
export const bankClient = createBankClient();

// --- Plaid Link (loaded on demand from Plaid's own host) ---
interface PlaidHandler { open(): void; destroy(): void }
interface PlaidGlobal {
  create(cfg: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
    onExit: (err: { display_message?: string | null } | null) => void;
  }): PlaidHandler;
}
const PLAID_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
let plaidLoading: Promise<PlaidGlobal> | null = null;

export function loadPlaid(): Promise<PlaidGlobal> {
  const g = (): PlaidGlobal | undefined => (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
  if (g()) return Promise.resolve(g()!);
  plaidLoading ??= new Promise<PlaidGlobal>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PLAID_SRC;
    s.async = true;
    s.onload = () => (g() ? resolve(g()!) : reject(new Error('Plaid did not load.')));
    s.onerror = () => { plaidLoading = null; reject(new Error('Could not load Plaid Link. The page may be blocking it.')); };
    document.head.appendChild(s);
  });
  return plaidLoading;
}

/** Opens Plaid Link; resolves true when a bank was connected, false when the person closed it. */
export async function runPlaidLink(client = bankClient): Promise<boolean> {
  const [token, Plaid] = await Promise.all([client.linkToken(), loadPlaid()]);
  return new Promise<boolean>((resolve, reject) => {
    const handler = Plaid.create({
      token,
      onSuccess: (publicToken, metadata) => {
        client.connect(publicToken, metadata.institution?.name ?? '').then(() => resolve(true), reject).finally(() => handler.destroy());
      },
      onExit: err => { handler.destroy(); if (err?.display_message) reject(new Error(err.display_message)); else resolve(false); },
    });
    handler.open();
  });
}
