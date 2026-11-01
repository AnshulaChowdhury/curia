// qbo-connection.ts — the QuickBooks Online connection for the MowMow books system.
//
// Curia is the only holder of the tokens (vault secret `qbo_tokens`). QuickBooks rotates the refresh token on every
// refresh, so exactly one process may refresh: refreshes are serialised here and the new token set is saved before the
// access token is handed to anyone. The books agent on the Mac mini never sees a token; it calls the narrow /books/qbo
// routes, which call `api()` below.

import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from '../logger.js';

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
} as const;
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
const REFRESH_MARGIN_MS = 5 * 60_000;
const STATE_TTL_MS = 10 * 60_000;
const TOKENS_SECRET = 'qbo_tokens';

export type QboEnvironment = keyof typeof API_BASE;

export interface QboSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: QboEnvironment;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  realmId: string;
  environment: QboEnvironment;
  connectedAt: string;
}

/** The slice of SecretsService this needs. */
export interface QboSecretsPort {
  getJSON<T>(name: string): Promise<T | null>;
  setJSON(name: string, obj: unknown): Promise<void>;
}

/** The authorization is missing, expired or revoked: someone has to press Connect again. */
export class QboAuthError extends Error {}

export class QboApiError extends Error {
  constructor(readonly status: number, message: string, readonly fault?: unknown) {
    super(`QuickBooks ${status}: ${message}`);
  }
}

export interface QboStatus {
  configured: boolean;
  connected: boolean;
  environment?: QboEnvironment;
  realmId?: string;
  connectedAt?: string;
  refreshExpiresAt?: string;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** Reads the settings from environment variables; null when any is missing. */
export function qboSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): QboSettings | null {
  const { QBO_CLIENT_ID: clientId, QBO_CLIENT_SECRET: clientSecret, QBO_REDIRECT_URI: redirectUri } = env;
  if (!clientId || !clientSecret || !redirectUri) return null;
  const environment = (env.QBO_ENVIRONMENT ?? 'production') as QboEnvironment;
  if (!(environment in API_BASE)) return null;
  return { clientId, clientSecret, redirectUri, environment };
}

export class QboConnection {
  private readonly pendingStates = new Map<string, number>(); // sha256(state) → expiry ms
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(
    private readonly settings: QboSettings | null,
    private readonly secrets: QboSecretsPort,
    private readonly logger: Logger,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {}

  // -- connecting ------------------------------------------------------------------------------------------------

  /** The Intuit sign-in address. The `state` is single-use and only valid for ten minutes. */
  authorizationUrl(): string {
    const s = this.requireSettings();
    const state = randomBytes(24).toString('base64url');
    this.pruneStates();
    this.pendingStates.set(hash(state), this.now() + STATE_TTL_MS);
    const q = new URLSearchParams({
      client_id: s.clientId,
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: s.redirectUri,
      state,
    });
    return `${AUTH_URL}?${q.toString()}`;
  }

  /** Called with the query Intuit sent to the redirect address. Throws QboAuthError on anything not right. */
  async handleCallback(query: { code?: string; realmId?: string; state?: string; error?: string }): Promise<void> {
    const s = this.requireSettings();
    if (query.error) throw new QboAuthError(`QuickBooks did not authorise the connection (${query.error})`);
    if (!query.state || !this.consumeState(query.state)) {
      throw new QboAuthError('this link has expired or was not started from Curia: press Connect again');
    }
    if (!query.code || !query.realmId) throw new QboAuthError('QuickBooks sent no authorisation code');
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code: query.code, redirect_uri: s.redirectUri });
    const tokens: StoredTokens = { ...t, realmId: query.realmId, environment: s.environment, connectedAt: new Date(this.now()).toISOString() };
    await this.secrets.setJSON(TOKENS_SECRET, tokens);
    this.logger.info({ realmId: tokens.realmId, environment: tokens.environment }, 'quickbooks: connected');
  }

  async status(): Promise<QboStatus> {
    if (!this.settings) return { configured: false, connected: false };
    const t = await this.secrets.getJSON<StoredTokens>(TOKENS_SECRET);
    if (!t || t.environment !== this.settings.environment || t.refreshExpiresAt <= this.now()) {
      return { configured: true, connected: false, environment: this.settings.environment };
    }
    return {
      configured: true,
      connected: true,
      environment: t.environment,
      realmId: t.realmId,
      connectedAt: t.connectedAt,
      refreshExpiresAt: new Date(t.refreshExpiresAt).toISOString(),
    };
  }

  // -- tokens ----------------------------------------------------------------------------------------------------

  private async tokens(forceRefresh = false): Promise<StoredTokens> {
    const s = this.requireSettings();
    const t = await this.secrets.getJSON<StoredTokens>(TOKENS_SECRET);
    if (!t) throw new QboAuthError('QuickBooks is not connected: press Connect in Curia');
    if (t.environment !== s.environment) {
      throw new QboAuthError(`the saved connection is for ${t.environment}, not ${s.environment}`);
    }
    if (!forceRefresh && t.accessExpiresAt - this.now() > REFRESH_MARGIN_MS) return t;
    if (t.refreshExpiresAt <= this.now()) {
      throw new QboAuthError('the QuickBooks refresh token has expired (unused for 100 days): press Connect again');
    }
    // One refresh at a time: a second caller waits for the first and gets its result.
    this.refreshing ??= this.refresh(t).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(old: StoredTokens): Promise<StoredTokens> {
    const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refreshToken });
    const fresh: StoredTokens = { ...t, realmId: old.realmId, environment: old.environment, connectedAt: old.connectedAt };
    await this.secrets.setJSON(TOKENS_SECRET, fresh); // saved before the new access token is used for anything
    return fresh;
  }

  private async tokenRequest(form: Record<string, string>): Promise<Pick<StoredTokens, 'accessToken' | 'refreshToken' | 'accessExpiresAt' | 'refreshExpiresAt'>> {
    const s = this.requireSettings();
    const started = this.now();
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${s.clientId}:${s.clientSecret}`).toString('base64'),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
    const data = safeJson(await res.text());
    if (res.status !== 200 || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
      if (data.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
        throw new QboAuthError('QuickBooks refused the authorisation (expired or revoked): press Connect again');
      }
      throw new QboApiError(res.status, 'token request failed');
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      accessExpiresAt: started + Number(data.expires_in ?? 3600) * 1000,
      refreshExpiresAt: started + Number(data.x_refresh_token_expires_in ?? 100 * 86400) * 1000,
    };
  }

  // -- API -------------------------------------------------------------------------------------------------------

  /** One QuickBooks call. Refreshes once on a 401; backs off on 429 and 5xx. Path is relative to the company. */
  async api(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const s = this.requireSettings();
    let refreshed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const t = await this.tokens();
      const q = new URLSearchParams({ ...params, minorversion: MINOR_VERSION });
      const res = await this.fetchFn(`${API_BASE[s.environment]}/v3/company/${t.realmId}/${path}?${q.toString()}`, {
        method,
        headers: {
          Authorization: `Bearer ${t.accessToken}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && !refreshed) {
        await this.tokens(true);
        refreshed = true;
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 4) {
        await this.sleep(2 ** attempt * 1000);
        continue;
      }
      const parsed = safeJson(await res.text());
      if (res.status === 401) throw new QboAuthError('QuickBooks rejected the access token after a refresh: press Connect again');
      if (res.status >= 400 || parsed.Fault) {
        const err = (parsed.Fault as { Error?: Array<{ Detail?: string; Message?: string }> } | undefined)?.Error?.[0];
        throw new QboApiError(res.status, err?.Detail ?? err?.Message ?? 'request failed', parsed.Fault);
      }
      return parsed;
    }
    throw new QboApiError(0, 'gave up after retries');
  }

  // -- state -----------------------------------------------------------------------------------------------------

  private consumeState(state: string): boolean {
    this.pruneStates();
    return this.pendingStates.delete(hash(state));
  }

  private pruneStates(): void {
    const t = this.now();
    for (const [k, exp] of this.pendingStates) if (exp <= t) this.pendingStates.delete(k);
  }

  private requireSettings(): QboSettings {
    if (!this.settings) throw new QboAuthError('QuickBooks is not configured (QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI)');
    return this.settings;
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function safeJson(text: string): Record<string, unknown> & { access_token?: unknown; refresh_token?: unknown } {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
