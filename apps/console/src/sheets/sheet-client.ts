// The owner-only /api/budget/sheets routes.

import { apiFetch } from '../api.js';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export interface SheetInfo { id: string; name: string; version: number; updatedAt: string; expiresAt: string }
export interface Sheet extends SheetInfo { workbook: Record<string, unknown> }

export class SheetError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
  get locked(): boolean { return this.status === 401 || this.status === 403; }
  get conflict(): boolean { return this.status === 409; }
}

export function createSheetClient(f: Fetcher = apiFetch) {
  async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await f(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!res.ok) {
      const reply = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new SheetError(typeof reply?.error === 'string' ? reply.error : 'Something went wrong.', res.status);
    }
    return (await res.json()) as T;
  }
  const one = (id: string) => `/api/budget/sheets/${encodeURIComponent(id)}`;
  return {
    list: async () => (await call<{ sheets: SheetInfo[] }>('/api/budget/sheets')).sheets,
    create: async (name: string, workbook: unknown, conversationId?: string) =>
      (await call<{ sheet: Sheet }>('/api/budget/sheets', 'POST', { name, workbook, ...(conversationId ? { conversationId } : {}) })).sheet,
    /** The sheet attached to a chat, without its cells. */
    attached: async (conversationId: string) =>
      (await call<{ sheet: SheetInfo | null }>(`/api/budget/sheets/attached?conversationId=${encodeURIComponent(conversationId)}`)).sheet,
    detach: async (conversationId: string) => { await call(`/api/budget/sheets/attached?conversationId=${encodeURIComponent(conversationId)}`, 'DELETE'); },
    get: async (id: string) => (await call<{ sheet: Sheet }>(one(id))).sheet,
    save: async (id: string, version: number, workbook: unknown) => (await call<{ sheet: SheetInfo }>(one(id), 'PUT', { version, workbook })).sheet,
    remove: async (id: string) => { await call(one(id), 'DELETE'); },
  };
}

export const sheetClient = createSheetClient();
