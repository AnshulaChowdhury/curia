// plaid-client.ts — the few Plaid calls the budget needs, over plain HTTPS (no SDK).
//
// Credentials come from the vault (plaid_client_id, plaid_secret, plaid_env) on every call, so changing them needs no
// restart. Errors carry Plaid's error code and a short message only, never the request body (it holds the secret).

export interface PlaidCredentials { clientId: string; secret: string; env: 'sandbox' | 'production' }
export interface PlaidAccount { account_id: string; name: string; official_name?: string | null; mask?: string | null }
export interface PlaidTransaction {
  transaction_id: string; account_id: string; date: string; amount: number; pending: boolean;
  name: string; merchant_name?: string | null; iso_currency_code?: string | null;
}
export interface SyncPage { added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: { transaction_id: string }[]; next_cursor: string; has_more: boolean; accounts: PlaidAccount[] }

export class PlaidError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
  /** The bank wants the owner to log in again (Plaid's ITEM_LOGIN_REQUIRED). */
  get needsLogin(): boolean { return this.code === 'ITEM_LOGIN_REQUIRED'; }
}

export interface PlaidClientOptions { credentials: () => Promise<PlaidCredentials | null>; fetchImpl?: typeof fetch }

const BASE = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' } as const;

export class PlaidClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: PlaidClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async configured(): Promise<boolean> { return (await this.options.credentials()) !== null; }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const c = await this.options.credentials();
    if (!c) throw new PlaidError('Plaid is not set up', 'NOT_CONFIGURED', 400);
    const res = await this.fetchImpl(`${BASE[c.env]}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: c.clientId, secret: c.secret, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json['error_code'] === 'string' ? json['error_code'] : 'UNKNOWN';
      const msg = typeof json['error_message'] === 'string' ? json['error_message'].slice(0, 200) : `HTTP ${res.status}`;
      throw new PlaidError(msg, code, res.status);
    }
    return json as T;
  }

  /** A short-lived token the browser hands to Plaid Link to start connecting a bank. */
  async createLinkToken(userId: string): Promise<string> {
    const r = await this.call<{ link_token: string }>('/link/token/create', {
      client_name: 'Curia budget', language: 'en', country_codes: ['CA'], user: { client_user_id: userId }, products: ['transactions'],
    });
    return r.link_token;
  }

  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const r = await this.call<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken });
    return { accessToken: r.access_token, itemId: r.item_id };
  }

  async sync(accessToken: string, cursor: string | null): Promise<SyncPage> {
    return this.call<SyncPage>('/transactions/sync', { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 });
  }

  async removeItem(accessToken: string): Promise<void> {
    await this.call('/item/remove', { access_token: accessToken });
  }
}

/** Reads the three vault entries; null unless the id and secret are both present. */
export async function plaidCredentialsFrom(secrets: { get(name: string): Promise<string | null> }): Promise<PlaidCredentials | null> {
  const [clientId, secret, env] = await Promise.all([secrets.get('plaid_client_id'), secrets.get('plaid_secret'), secrets.get('plaid_env')]);
  if (!clientId || !secret) return null;
  return { clientId, secret, env: env === 'production' ? 'production' : 'sandbox' };
}
