// nylas-unsubscribe.ts — reads the List-Unsubscribe headers of ONE email (GET /messages/{id}?fields=include_headers).
//
// Read-only. Nothing is stored. Errors carry the HTTP status only, never a response body.

import { NYLAS_REGIONS, NylasMailboxError, type NylasRegion } from './nylas-mailbox.js';
import { MailboxRateLimitedError } from './phone-inbox-service.js';

export interface UnsubscribeHeaders {
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  /** The sender's address as Nylas parsed it, lower-case, or null. */
  fromAddress: string | null;
}

interface NylasHeaderMessage {
  from?: Array<{ email?: string }>;
  headers?: Array<{ name?: string; value?: string }>;
}

export class NylasUnsubscribeReader {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    grantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    region: NylasRegion = 'us',
  ) {
    this.baseUrl = `${NYLAS_REGIONS[region]}/v3/grants/${encodeURIComponent(grantId)}`;
  }

  /** The headers, or null when the message does not exist (deleted or not in this mailbox). */
  async read(messageId: string): Promise<UnsubscribeHeaders | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/messages/${encodeURIComponent(messageId)}?fields=include_headers`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new MailboxRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (!res.ok) throw new NylasMailboxError(res.status, 'message');
    const json = (await res.json()) as { data?: NylasHeaderMessage };
    const headers = json.data?.headers ?? [];
    const find = (name: string) => headers.find((h) => h.name?.toLowerCase() === name)?.value ?? null;
    return {
      listUnsubscribe: find('list-unsubscribe'),
      listUnsubscribePost: find('list-unsubscribe-post'),
      fromAddress: json.data?.from?.[0]?.email?.trim().toLowerCase() || null,
    };
  }
}

/** The reader for one mailbox from the vault, or null when it has no Nylas key or grant (not connected). */
export async function loadUnsubscribeReader(
  secrets: { get(name: string): Promise<string | null> },
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NylasUnsubscribeReader | null> {
  const apiKey = (await secrets.get('nylas_api_key'))?.trim();
  const regionSetting = (await secrets.get('nylas_region'))?.trim().toLowerCase() || 'us';
  if (!(regionSetting in NYLAS_REGIONS)) {
    throw new Error(`nylas_region must be 'us' or 'eu', got '${regionSetting}'`);
  }
  const region = regionSetting as NylasRegion; // checked against NYLAS_REGIONS above
  const grant = (await secrets.get(`phone_inbox_grant_${accountId.replace('-', '_')}`))?.trim();
  return apiKey && grant ? new NylasUnsubscribeReader(apiKey, grant, fetchImpl, region) : null;
}
