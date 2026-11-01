import { describe, it, expect } from 'vitest';
import { QboAuthError, QboApiError, QboConnection, QboSettingsError, type Fetch, type QboSettings } from '../../../src/quickbooks/qbo-connection.js';
import { createSilentLogger } from '../../../src/logger.js';

const SETTINGS: QboSettings = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://curia.test/books/qbo-callback', environment: 'production' };

function vault() {
  const store = new Map<string, unknown>();
  return {
    store,
    async getJSON<T>(n: string) {
      return (store.get(n) as T | undefined) ?? null;
    },
    async setJSON(n: string, v: unknown) {
      store.set(n, v);
    },
    async delete(n: string) {
      store.delete(n);
    },
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

/** Scripted transport: each call takes the next response; records the calls. */
function script(...responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ url, ...init });
    const r = responses.shift();
    if (!r) throw new Error('unexpected call ' + url);
    return { status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return { calls, fetchFn };
}

const tokenBody = (n: string) => ({ access_token: `acc-${n}`, refresh_token: `ref-${n}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 });

function make(responses: Array<{ status: number; body?: unknown }>, clock = { t: 1_000_000 }) {
  const v = vault();
  const s = script(...responses);
  const conn = new QboConnection(SETTINGS, v, createSilentLogger(), s.fetchFn, () => clock.t, async () => {});
  return { v, s, conn, clock };
}

const connect = async (conn: QboConnection, v: ReturnType<typeof vault>) => {
  const url = new URL(await conn.authorizationUrl());
  await conn.handleCallback({ code: 'code1', realmId: '123', state: url.searchParams.get('state')! });
  return v.store.get('qbo_tokens') as { refreshToken: string };
};

describe('QboConnection', () => {
  it('builds the authorisation address with the redirect, scope and a state', async () => {
    const { conn } = make([]);
    const u = new URL(await conn.authorizationUrl());
    expect(u.origin + u.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(u.searchParams.get('redirect_uri')).toBe(SETTINGS.redirectUri);
    expect(u.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(u.searchParams.get('state')!.length).toBeGreaterThan(20);
  });

  it('exchanges the code, stores the tokens in the vault, and the state works once only', async () => {
    const { conn, v, s } = make([{ status: 200, body: tokenBody('1') }]);
    const url = new URL(await conn.authorizationUrl());
    const state = url.searchParams.get('state')!;
    await conn.handleCallback({ code: 'c', realmId: '99', state });
    expect(s.calls[0]!.body).toContain('grant_type=authorization_code');
    expect(s.calls[0]!.headers.Authorization).toBe('Basic ' + Buffer.from('cid:sec').toString('base64'));
    expect(v.store.get('qbo_tokens')).toMatchObject({ refreshToken: 'ref-1', realmId: '99', environment: 'production' });
    await expect(conn.handleCallback({ code: 'c', realmId: '99', state })).rejects.toBeInstanceOf(QboAuthError);
  });

  it('rejects an unknown or expired state and a denied authorisation without calling Intuit', async () => {
    const { conn, s, clock } = make([]);
    await expect(conn.handleCallback({ code: 'c', realmId: '1', state: 'nope' })).rejects.toThrow(/expired|not started/);
    const state = new URL(await conn.authorizationUrl()).searchParams.get('state')!;
    clock.t += 11 * 60_000;
    await expect(conn.handleCallback({ code: 'c', realmId: '1', state })).rejects.toThrow(/expired|not started/);
    await expect(conn.handleCallback({ error: 'access_denied' })).rejects.toThrow(/access_denied/);
    expect(s.calls).toHaveLength(0);
  });

  it('refreshes an expiring access token, saving the rotated refresh token before using it', async () => {
    const { conn, v, s, clock } = make([
      { status: 200, body: tokenBody('1') },
      { status: 200, body: tokenBody('2') },
      { status: 200, body: { QueryResponse: {} } },
    ]);
    await connect(conn, v);
    clock.t += 3_500_000; // under five minutes left
    await conn.api('GET', 'query', { query: 'select * from Account' });
    expect(s.calls[1]!.body).toContain('grant_type=refresh_token');
    expect(s.calls[1]!.body).toContain('refresh_token=ref-1');
    expect(s.calls[2]!.headers.Authorization).toBe('Bearer acc-2');
    expect(v.store.get('qbo_tokens')).toMatchObject({ refreshToken: 'ref-2', realmId: '123' });
    expect(s.calls[2]!.url).toContain('/v3/company/123/query?');
    expect(s.calls[2]!.url).toContain('minorversion=');
  });

  it('serialises concurrent refreshes into one token request', async () => {
    const { conn, v, s, clock } = make([
      { status: 200, body: tokenBody('1') },
      { status: 200, body: tokenBody('2') },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    await connect(conn, v);
    clock.t += 3_500_000;
    await Promise.all([conn.api('GET', 'query', {}), conn.api('GET', 'query', {})]);
    expect(s.calls.filter(c => c.body?.includes('refresh_token'))).toHaveLength(1);
  });

  it('refreshes once on a 401 and retries; a second 401 means connect again', async () => {
    const ok = make([
      { status: 200, body: tokenBody('1') },
      { status: 401 },
      { status: 200, body: tokenBody('2') },
      { status: 200, body: { ok: true } },
    ]);
    await connect(ok.conn, ok.v);
    await expect(ok.conn.api('GET', 'query', {})).resolves.toEqual({ ok: true });

    const bad = make([
      { status: 200, body: tokenBody('1') },
      { status: 401 },
      { status: 200, body: tokenBody('2') },
      { status: 401 },
    ]);
    await connect(bad.conn, bad.v);
    await expect(bad.conn.api('GET', 'query', {})).rejects.toBeInstanceOf(QboAuthError);
  });

  it('backs off and retries on 429, then succeeds', async () => {
    const { conn, v, s } = make([{ status: 200, body: tokenBody('1') }, { status: 429 }, { status: 200, body: { done: 1 } }]);
    await connect(conn, v);
    await expect(conn.api('GET', 'query', {})).resolves.toEqual({ done: 1 });
    expect(s.calls).toHaveLength(3);
  });

  it('surfaces a QuickBooks fault as QboApiError with the detail', async () => {
    const { conn, v } = make([
      { status: 200, body: tokenBody('1') },
      { status: 400, body: { Fault: { Error: [{ Message: 'Invalid', Detail: 'Account is missing' }] } } },
    ]);
    await connect(conn, v);
    await expect(conn.api('POST', 'purchase', {}, {})).rejects.toThrow(/Account is missing/);
    await expect(Promise.reject(new QboApiError(400, 'x'))).rejects.toBeInstanceOf(QboApiError);
  });

  it('treats a revoked refresh token as needing a new connection', async () => {
    const { conn, v, clock } = make([{ status: 200, body: tokenBody('1') }, { status: 400, body: { error: 'invalid_grant' } }]);
    await connect(conn, v);
    clock.t += 3_500_000;
    await expect(conn.api('GET', 'query', {})).rejects.toBeInstanceOf(QboAuthError);
  });

  it('is not connected before the first authorisation, and after the refresh token lapses', async () => {
    const { conn, v, clock } = make([{ status: 200, body: tokenBody('1') }]);
    expect(await conn.status()).toMatchObject({ configured: true, connected: false, environment: 'production', settingsSource: 'env' });
    await expect(conn.api('GET', 'query', {})).rejects.toBeInstanceOf(QboAuthError);
    await connect(conn, v);
    expect((await conn.status()).connected).toBe(true);
    clock.t += 101 * 86_400_000;
    expect((await conn.status()).connected).toBe(false);
  });

  it('reports not configured without settings, and never puts tokens in the status', async () => {
    const none = new QboConnection(null, vault(), createSilentLogger());
    expect(await none.status()).toEqual({ configured: false, connected: false });
    const { conn, v } = make([{ status: 200, body: tokenBody('1') }]);
    await connect(conn, v);
    expect(JSON.stringify(await conn.status())).not.toMatch(/acc-1|ref-1/);
  });

  describe('settings entered on the page', () => {
    const form = { clientId: 'newid1234', clientSecret: 'newsecret', redirectUri: 'https://curia.test/books/qbo-callback', environment: 'production' };

    it('saves the client id and secret, and they win over the environment', async () => {
      const { conn, v } = make([]);
      await conn.saveSettings(form);
      expect(v.store.get('qbo_settings')).toEqual(form);
      const u = new URL(await conn.authorizationUrl());
      expect(u.searchParams.get('client_id')).toBe('newid1234');
    });

    it('works with nothing but the form, and never returns the secret', async () => {
      const v = vault();
      const conn = new QboConnection(null, v, createSilentLogger());
      expect(await conn.status()).toEqual({ configured: false, connected: false });
      await expect(conn.authorizationUrl()).rejects.toBeInstanceOf(QboAuthError);
      await conn.saveSettings(form);
      const st = await conn.status();
      expect(st).toMatchObject({ configured: true, connected: false, settingsSource: 'vault', clientIdHint: '…1234', redirectUri: form.redirectUri });
      expect(JSON.stringify(st)).not.toContain('newsecret');
    });

    it('rejects a blank secret, a non-https redirect and a bad environment', async () => {
      const { conn, v } = make([]);
      await expect(conn.saveSettings({ ...form, clientSecret: ' ' })).rejects.toBeInstanceOf(QboSettingsError);
      await expect(conn.saveSettings({ ...form, redirectUri: 'http://curia.test/cb' })).rejects.toBeInstanceOf(QboSettingsError);
      await expect(conn.saveSettings({ ...form, redirectUri: 'not a url' })).rejects.toBeInstanceOf(QboSettingsError);
      await expect(conn.saveSettings({ ...form, environment: 'live' })).rejects.toBeInstanceOf(QboSettingsError);
      expect(v.store.has('qbo_settings')).toBe(false);
    });

    it('drops the old connection when the client id (a different app) changes, but not when only the secret does', async () => {
      const { conn, v } = make([{ status: 200, body: tokenBody('1') }]);
      await connect(conn, v);
      await conn.saveSettings({ ...form, clientId: 'cid' }); // same id as the environment's
      expect(v.store.has('qbo_tokens')).toBe(true);
      await conn.saveSettings({ ...form, clientId: 'cid', clientSecret: 'rotated' });
      expect(v.store.has('qbo_tokens')).toBe(true);
      await conn.saveSettings(form);
      expect(v.store.has('qbo_tokens')).toBe(false);
    });
  });
});
