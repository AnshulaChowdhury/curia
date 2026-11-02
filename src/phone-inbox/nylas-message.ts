// nylas-message.ts — the plain text of ONE email, for GET /phone/message (the Command Hub email page).
//
// Read-only (GET requests only). Asked for only when the owner opens an email. The text is converted to plain text,
// cut at MAX_BODY_CHARS, and handed straight back: nothing here logs it, caches it or keeps it. Errors carry the
// HTTP status only, never a response body. Kept apart from nylas-mailbox.ts, whose inbox reader never touches bodies.

import { htmlToText } from '../channels/email/html-to-text.js';
import { NYLAS_REGIONS, NylasMailboxError, type NylasRegion } from './nylas-mailbox.js';
import { MailboxRateLimitedError } from './phone-inbox-service.js';

export const MAX_BODY_CHARS = 20_000;
// Enough to find the newest received message in a thread; a thread longer than this still answers with its newest few.
const THREAD_PAGE_LIMIT = 10;
// Gmail label ids. Mail we sent or have not sent is not "the email" the owner opened.
const OWN_MAIL_FOLDERS = new Set(['SENT', 'DRAFT']);

export interface PhoneMessageText {
  body: string;
  truncated: boolean;
}

interface NylasFullMessage {
  id: string;
  thread_id?: string;
  body?: string;
  snippet?: string;
  date?: number;
  folders?: string[];
}

/** Cuts to the limit without splitting a surrogate pair (an emoji) in half. */
export function capText(text: string): PhoneMessageText {
  if (text.length <= MAX_BODY_CHARS) return { body: text, truncated: false };
  let end = MAX_BODY_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { body: text.slice(0, end), truncated: true };
}

function plainText(m: NylasFullMessage): PhoneMessageText {
  const text = (m.body ? htmlToText(m.body) : '').trim() || (m.snippet ?? '').trim();
  return capText(text);
}

export class NylasMessageReader {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    grantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    region: NylasRegion = 'us',
  ) {
    this.baseUrl = `${NYLAS_REGIONS[region]}/v3/grants/${encodeURIComponent(grantId)}`;
  }

  /**
   * With a messageId: that message, if it belongs to the thread. Without one: the newest message in the thread that
   * we did not send. Null when there is no such email (deleted, archived away, or not in this mailbox).
   */
  async read(threadId: string, messageId?: string): Promise<PhoneMessageText | null> {
    if (messageId) {
      const m = await this.get<NylasFullMessage>(`/messages/${encodeURIComponent(messageId)}`);
      if (!m) return null;
      // A message id from a different thread is not the email the phone asked about.
      if (m.thread_id && m.thread_id !== threadId) return null;
      return plainText(m);
    }
    const query = new URLSearchParams({ thread_id: threadId, limit: String(THREAD_PAGE_LIMIT) });
    const list = await this.get<NylasFullMessage[]>(`/messages?${query}`);
    const received = (list ?? [])
      .filter((m) => !(m.folders ?? []).some((f) => OWN_MAIL_FOLDERS.has(f.toUpperCase())))
      .sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
    const newest = received[0];
    return newest ? plainText(newest) : null;
  }

  /** One GET. A 404 is "no such email" (null); anything else that is not 2xx throws with the status only. */
  private async get<T>(path: string): Promise<T | null> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new MailboxRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (!res.ok) throw new NylasMailboxError(res.status, 'message');
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  }
}

/** Builds the reader for one mailbox from the vault, or null when it has no Nylas key or grant (not connected). */
export async function loadPhoneMessageReader(
  secrets: { get(name: string): Promise<string | null> },
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NylasMessageReader | null> {
  const apiKey = (await secrets.get('nylas_api_key'))?.trim();
  const regionSetting = (await secrets.get('nylas_region'))?.trim().toLowerCase() || 'us';
  if (!(regionSetting in NYLAS_REGIONS)) {
    throw new Error(`nylas_region must be 'us' or 'eu', got '${regionSetting}'`);
  }
  const region = regionSetting as NylasRegion; // checked against NYLAS_REGIONS above
  const grant = (await secrets.get(`phone_inbox_grant_${accountId.replace('-', '_')}`))?.trim();
  return apiKey && grant ? new NylasMessageReader(apiKey, grant, fetchImpl, region) : null;
}
