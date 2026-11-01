// nylas-mailbox.ts — MailboxReader over the Nylas v3 REST API (read-only: GET requests only).
//
// Uses fetch directly, like skills/_shared/ceo-nylas-client.ts, so the phone endpoint depends on
// nothing but the API key and one grant id per mailbox. Never requests or returns message bodies.

import {
  MailboxRateLimitedError,
  groupOfLabel,
  type InboxMessage,
  type InboxSnapshot,
  type MailboxReader,
  type SentMessage,
} from './phone-inbox-service.js';

// Nylas applications live in one data region; its API host must match (an EU app's key and grants
// don't work against the US host). Only these two are accepted, so a typo can't send the key elsewhere.
export const NYLAS_REGIONS = { us: 'https://api.us.nylas.com', eu: 'https://api.eu.nylas.com' } as const;
export type NylasRegion = keyof typeof NYLAS_REGIONS;
// Per triage tag. More than this tagged and unread is already far past "needs you".
const TAG_PAGE_LIMIT = 50;
// Sent mail since the oldest candidate arrived; a few days of sent mail is well inside this.
const SENT_PAGE_LIMIT = 50;

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
  unread_count?: number;
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

  async inboxSnapshot(): Promise<InboxSnapshot> {
    // Google limits queries per user per minute, and Nylas passes our reads through. So: list the folders (one
    // small call), then ask only for each triage tag's unread mail, never the whole inbox.
    const folders = await this.get<NylasFolder>('/folders', 'folders');
    const nameById = new Map(folders.map((f) => [f.id, f.name ?? ''] as const));
    const inbox = folders.find((f) => f.id === 'INBOX' || f.name?.toUpperCase() === 'INBOX');
    const tagIds = folders.filter((f) => groupOfLabel(f.name ?? '') !== null).map((f) => f.id);

    const byId = new Map<string, InboxMessage>();
    for (const tagId of tagIds) {
      const query = new URLSearchParams({ in: tagId, unread: 'true', limit: String(TAG_PAGE_LIMIT) });
      for (const m of await this.get<NylasMessage>(`/messages?${query}`, 'messages')) {
        const folderNames = (m.folders ?? []).map((id) => nameById.get(id) ?? id);
        // A tagged message that has been archived is no longer waiting on you.
        if (!folderNames.some((n) => n.toUpperCase() === 'INBOX')) continue;
        byId.set(m.id, {
          id: m.id,
          threadId: m.thread_id ?? '',
          subject: m.subject ?? '',
          fromName: m.from?.[0]?.name || undefined,
          fromEmail: m.from?.[0]?.email || undefined,
          date: m.date ?? 0,
          folderNames,
        });
      }
    }
    return { messages: [...byId.values()].sort((x, y) => y.date - x.date), unreadCount: inbox?.unread_count };
  }

  async sentSince(sinceSeconds: number): Promise<SentMessage[]> {
    const query = new URLSearchParams({ in: 'SENT', received_after: String(sinceSeconds), limit: String(SENT_PAGE_LIMIT) });
    const messages = await this.get<NylasMessage>(`/messages?${query}`, 'sent');
    return messages.map((m) => ({ threadId: m.thread_id ?? '', date: m.date ?? 0 }));
  }

  private async get<T>(path: string, endpoint: string): Promise<T[]> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    // The status is enough to debug; the response body is never logged or surfaced.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new MailboxRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (!res.ok) throw new NylasMailboxError(res.status, endpoint);
    const json = (await res.json()) as NylasListResponse<T>;
    return json.data ?? [];
  }
}
