// nylas-mailbox.ts — MailboxReader over the Nylas v3 REST API (read-only: GET requests only).
//
// Uses fetch directly, like skills/_shared/ceo-nylas-client.ts, so the phone endpoint depends on
// nothing but the API key and one grant id per mailbox. Never requests or returns message bodies.

import type { InboxMessage, MailboxReader, SentMessage } from './phone-inbox-service.js';

// Nylas applications live in one data region; its API host must match (an EU app's key and grants
// don't work against the US host). Only these two are accepted, so a typo can't send the key elsewhere.
export const NYLAS_REGIONS = { us: 'https://api.us.nylas.com', eu: 'https://api.eu.nylas.com' } as const;
export type NylasRegion = keyof typeof NYLAS_REGIONS;
// Nylas caps one page at 200. More unread than this is already far past "needs you".
const PAGE_LIMIT = 200;

interface NylasListResponse<T> {
  data?: T[];
}

interface NylasMessage {
  id: string;
  thread_id?: string;
  subject?: string;
  from?: Array<{ name?: string; email?: string }>;
  date?: number;
  folders?: string[];
}

interface NylasFolder {
  id: string;
  name?: string;
}

export class NylasMailboxError extends Error {
  constructor(public readonly status: number, public readonly endpoint: string) {
    super(`Nylas ${endpoint} failed with status ${status}`);
    this.name = 'NylasMailboxError';
  }
}

export class NylasMailbox implements MailboxReader {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    grantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    region: NylasRegion = 'us',
  ) {
    this.baseUrl = `${NYLAS_REGIONS[region]}/v3/grants/${encodeURIComponent(grantId)}`;
  }

  async unreadInbox(): Promise<InboxMessage[]> {
    const [folders, messages] = await Promise.all([
      this.get<NylasFolder>('/folders', 'folders'),
      this.get<NylasMessage>(`/messages?${new URLSearchParams({ in: 'INBOX', unread: 'true', limit: String(PAGE_LIMIT) })}`, 'messages'),
    ]);
    const nameById = new Map(folders.map((f) => [f.id, f.name ?? ''] as const));
    return messages.map((m) => ({
      id: m.id,
      threadId: m.thread_id ?? '',
      subject: m.subject ?? '',
      fromName: m.from?.[0]?.name || undefined,
      fromEmail: m.from?.[0]?.email || undefined,
      date: m.date ?? 0,
      // Unknown ids fall back to the id itself: Gmail system labels use their name as their id.
      folderNames: (m.folders ?? []).map((id) => nameById.get(id) ?? id),
    }));
  }

  async sentSince(sinceSeconds: number): Promise<SentMessage[]> {
    const query = new URLSearchParams({ in: 'SENT', received_after: String(sinceSeconds), limit: String(PAGE_LIMIT) });
    const messages = await this.get<NylasMessage>(`/messages?${query}`, 'sent');
    return messages.map((m) => ({ threadId: m.thread_id ?? '', date: m.date ?? 0 }));
  }

  private async get<T>(path: string, endpoint: string): Promise<T[]> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    // The status is enough to debug; the response body is never logged or surfaced.
    if (!res.ok) throw new NylasMailboxError(res.status, endpoint);
    const json = (await res.json()) as NylasListResponse<T>;
    return json.data ?? [];
  }
}
