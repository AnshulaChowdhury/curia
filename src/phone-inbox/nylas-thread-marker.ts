// nylas-thread-marker.ts — marks a whole mail thread read in the mailbox (PUT /threads/{id} with unread:false).
//
// The only mailbox write the phone is allowed besides the triage label: it sends { unread: false } and nothing else, so it
// can never mark mail unread, move it, archive it, delete it or touch a label. Idempotent. Errors carry the status only.

import { NYLAS_REGIONS, NylasMailboxError, type NylasRegion } from './nylas-mailbox.js';
import { MailboxRateLimitedError } from './phone-inbox-service.js';

export class NylasThreadMarker {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    grantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    region: NylasRegion = 'us',
  ) {
    this.baseUrl = `${NYLAS_REGIONS[region]}/v3/grants/${encodeURIComponent(grantId)}`;
  }

  /** True once the thread is read. A thread that no longer exists counts as done (there is nothing left to mark). */
  async markRead(threadId: string): Promise<true> {
    const res = await this.fetchImpl(`${this.baseUrl}/threads/${encodeURIComponent(threadId)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ unread: false }),
    });
    if (res.status === 404) return true;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new MailboxRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (!res.ok) throw new NylasMailboxError(res.status, 'thread');
    return true;
  }
}

/** The marker for one mailbox from the vault, or null when it has no Nylas key or grant (not connected). */
export async function loadPhoneThreadMarker(
  secrets: { get(name: string): Promise<string | null> },
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NylasThreadMarker | null> {
  const apiKey = (await secrets.get('nylas_api_key'))?.trim();
  const regionSetting = (await secrets.get('nylas_region'))?.trim().toLowerCase() || 'us';
  if (!(regionSetting in NYLAS_REGIONS)) {
    throw new Error(`nylas_region must be 'us' or 'eu', got '${regionSetting}'`);
  }
  const region = regionSetting as NylasRegion; // checked against NYLAS_REGIONS above
  const grant = (await secrets.get(`phone_inbox_grant_${accountId.replace('-', '_')}`))?.trim();
  return apiKey && grant ? new NylasThreadMarker(apiKey, grant, fetchImpl, region) : null;
}
