import { describe, it, expect, vi } from 'vitest';
import { PlaidClient, PlaidError, plaidCredentialsFrom } from '../../../src/budget/plaid-client.js';
import { toNewTransaction } from '../../../src/budget/bank-sync.js';

// Every id, name and amount below is invented.
const creds = { clientId: 'cid', secret: 'sec', env: 'sandbox' as const };
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe('PlaidClient', () => {
  it('posts to the sandbox host with the credentials in the body, and returns the link token', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok({ link_token: 'link-sandbox-1' }));
    const c = new PlaidClient({ credentials: async () => creds, fetchImpl: f as unknown as typeof fetch });
    expect(await c.createLinkToken('owner')).toBe('link-sandbox-1');
    expect(f.mock.calls[0]![0]).toBe('https://sandbox.plaid.com/link/token/create');
    const body = JSON.parse(String(f.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ client_id: 'cid', secret: 'sec', country_codes: ['CA'], products: ['transactions'] });
  });

  it('uses the production host when told to', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false, accounts: [] }));
    await new PlaidClient({ credentials: async () => ({ ...creds, env: 'production' }), fetchImpl: f as unknown as typeof fetch }).sync('tok', null);
    expect(f.mock.calls[0]![0]).toBe('https://production.plaid.com/transactions/sync');
  });

  it('raises a PlaidError with the code, and never echoes the request body (it holds the secret)', async () => {
    const f = async () => ({ ok: false, status: 400, json: async () => ({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login again' }) }) as Response;
    const c = new PlaidClient({ credentials: async () => creds, fetchImpl: f as unknown as typeof fetch });
    const err = await c.sync('tok', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidError);
    expect((err as PlaidError).needsLogin).toBe(true);
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain('sec');
  });

  it('refuses to call Plaid when no credentials are stored', async () => {
    const c = new PlaidClient({ credentials: async () => null, fetchImpl: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch });
    expect(await c.configured()).toBe(false);
    await expect(c.createLinkToken('owner')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('plaidCredentialsFrom', () => {
  const vault = (m: Record<string, string>) => ({ get: async (n: string) => m[n] ?? null });
  it('needs both the id and the secret, and defaults to sandbox', async () => {
    expect(await plaidCredentialsFrom(vault({ plaid_client_id: 'a' }))).toBeNull();
    expect(await plaidCredentialsFrom(vault({ plaid_client_id: 'a', plaid_secret: 'b' }))).toEqual({ clientId: 'a', secret: 'b', env: 'sandbox' });
    expect((await plaidCredentialsFrom(vault({ plaid_client_id: 'a', plaid_secret: 'b', plaid_env: 'production' })))?.env).toBe('production');
  });
});

describe('toNewTransaction', () => {
  const t = { transaction_id: 'tx1', account_id: 'a1', date: '2031-03-09', amount: 25, pending: false, name: 'INVENTED GROCER #12', merchant_name: 'Invented Grocer', iso_currency_code: 'CAD' };
  it('flips the sign: Plaid reports money out as positive', () => {
    expect(toNewTransaction(t, 'Bank Chequing')).toMatchObject({ amountCents: -2500, payee: 'Invented Grocer', description: 'INVENTED GROCER #12', externalId: 'tx1' });
    expect(toNewTransaction({ ...t, amount: -10.5 }, 'x')?.amountCents).toBe(1050);
  });
  it('skips pending and non-CAD rows', () => {
    expect(toNewTransaction({ ...t, pending: true }, 'x')).toBeNull();
    expect(toNewTransaction({ ...t, iso_currency_code: 'USD' }, 'x')).toBeNull();
  });
  it('is exact for amounts that floats get wrong', () => {
    expect(toNewTransaction({ ...t, amount: 0.07 }, 'x')?.amountCents).toBe(-7);
    expect(toNewTransaction({ ...t, amount: 1.15 }, 'x')?.amountCents).toBe(-115);
  });
});
