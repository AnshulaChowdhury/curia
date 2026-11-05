// nylas-triage-source.ts — one Nylas mailbox as a TriageSource.
//
// Reads inbox mail (read or unread, since a start date) that carries no triage label, with a short preview but never a body, and writes only
// the triage label, plus "read" for newsletter and spam mail (FR-ETW-5). Uses fetch directly, like
// src/phone-inbox/nylas-mailbox.ts.

import { NYLAS_REGIONS, type NylasRegion } from '../phone-inbox/nylas-mailbox.js';
import type { TriageProgress } from './progress-store.js';
import { MailboxRateLimitedError } from '../phone-inbox/phone-inbox-service.js';
import { TRIAGE_LABELS, marksRead, triageGroupOfLabel, type TriageCandidate, type TriageGroup } from './types.js';
import type { TriageSource } from './watcher.js';

interface NylasFolder { id: string; name?: string; attributes?: string[] }
interface NylasMessage {
  id: string;
  thread_id?: string;
  subject?: string;
  snippet?: string;
  date?: number;
  from?: Array<{ name?: string; email?: string }>;
  folders?: string[];
  unread?: boolean;
}
interface NylasList<T> { data?: T[]; next_cursor?: string }

/** Most new candidates one listing returns, and how many Nylas pages it will read to find them. */
const LIST_LIMIT = 20;
const PAGE_SIZE = 50;
const MAX_PAGES = 8;
/** With no earlier pass on record (a mailbox never triaged), look back this far. */
const FIRST_RUN_LOOKBACK_SECONDS = 24 * 3600;
/** Each listing starts a little before the last successful pass, so mail that arrived late is not missed. */
const OVERLAP_SECONDS = 3600;
const SNIPPET_MAX_CHARS = 400;
const EXCLUDED = new Set(['SPAM', 'TRASH', 'DRAFT', 'SENT']);

export class NylasTriageSource implements TriageSource {
  private readonly baseUrl: string;
  /** Unix seconds where the next listing starts; read from the progress record on first use. */
  private windowStart: number | null = null;
  /** The time the last complete listing began. Becomes the progress mark once the watcher has handled all of it. */
  private pendingMark: number | null = null;

  constructor(
    readonly accountId: string,
    private readonly apiKey: string,
    grantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    region: NylasRegion = 'us',
    /** Unix seconds. Mail received before this is never triaged, whatever the progress record says. */
    private readonly since: number = 0,
    /** Remembers the last successful pass, so a restart resumes from there. Without it, every listing starts at `since`. */
    private readonly progress?: TriageProgress,
  ) {
    this.baseUrl = `${NYLAS_REGIONS[region]}/v3/grants/${encodeURIComponent(grantId)}`;
  }

  async listUntagged(isKnown?: (messageId: string) => Promise<boolean>): Promise<TriageCandidate[]> {
    const folders = await this.request<NylasList<NylasFolder>>('GET', '/folders');
    const nameById = new Map((folders.data ?? []).map((f) => [f.id, f.name ?? ''] as const));

    const startedAt = Math.floor(Date.now() / 1000);
    const after = await this.listingStart(startedAt);

    const out: TriageCandidate[] = [];
    let cursor: string | undefined;
    // Newest first, read or unread. The window starts at the last successful pass, so it is normally minutes wide:
    // a steady 30-second check costs one small Nylas call (Google rate-limits big reads).
    let exhausted = false;
    for (let page = 0; page < MAX_PAGES && out.length < LIST_LIMIT; page += 1) {
      const query = new URLSearchParams({ in: 'INBOX', limit: String(PAGE_SIZE) });
      if (after > 0) query.set('received_after', String(after));
      if (cursor) query.set('page_token', cursor);
      const messages = await this.request<NylasList<NylasMessage>>('GET', `/messages?${query}`);

      for (const m of messages.data ?? []) {
        const names = (m.folders ?? []).map((id) => nameById.get(id) ?? id);
        if (names.some((n) => EXCLUDED.has(n.toUpperCase()))) continue;
        if (names.some((n) => triageGroupOfLabel(n) !== null)) continue; // already tagged (current or earlier label names)
        if (isKnown && (await isKnown(m.id))) continue; // handled before; "none" mail stays untagged but is not asked about again
        out.push({
          accountId: this.accountId,
          messageId: m.id,
          threadId: m.thread_id ?? '',
          from: m.from?.[0]?.name || m.from?.[0]?.email || '',
          ...(m.from?.[0]?.email ? { fromAddress: m.from[0].email } : {}),
          subject: m.subject ?? '',
          snippet: (m.snippet ?? '').slice(0, SNIPPET_MAX_CHARS),
          receivedAt: m.date ?? 0,
          unread: m.unread !== false,
        });
      }
      cursor = messages.next_cursor;
      if (!cursor) {
        exhausted = true;
        break;
      }
    }
    // Only a listing that reached the end of the window can move the mark; the watcher confirms once it has handled it all.
    this.pendingMark = exhausted ? startedAt : null;
    return out;
  }

  /**
   * Called by the watcher after a pass. When the last listing covered the whole window and the watcher handled every message in it,
   * that listing's start time is saved as the last successful triage, and the next listing starts from there.
   */
  async commitProgress(allHandled: boolean): Promise<void> {
    const mark = this.pendingMark;
    this.pendingMark = null;
    if (!allHandled || mark === null) return;
    this.windowStart = Math.max(this.since, mark - OVERLAP_SECONDS);
    await this.progress?.set(this.accountId, mark * 1000);
  }

  private async listingStart(nowSeconds: number): Promise<number> {
    if (this.windowStart === null) {
      const saved = this.progress ? await this.progress.get(this.accountId) : null;
      const start = saved !== null ? Math.floor(saved / 1000) - OVERLAP_SECONDS : nowSeconds - FIRST_RUN_LOOKBACK_SECONDS;
      // Without a progress store there is nothing to resume from: `since` alone decides.
      this.windowStart = this.progress ? Math.max(this.since, start) : this.since;
    }
    return this.windowStart;
  }

  async applyLabel(messageId: string, group: TriageGroup): Promise<void> {
    const folders = await this.request<NylasList<NylasFolder>>('GET', '/folders');
    // Reuse a label with exactly the current name (any case); an earlier-named label ("✍️ Drafted") is not reused,
    // so the rename takes effect. The bare system folder "SPAM" can never match: the label is "Likely spam".
    const wanted = TRIAGE_LABELS[group].toLowerCase();
    const existing = (folders.data ?? []).find((f) => (f.name ?? '').trim().toLowerCase() === wanted);
    const labelId = existing
      ? existing.id
      : (await this.request<{ data: NylasFolder }>('POST', '/folders', { name: TRIAGE_LABELS[group] })).data.id;

    // A message's folders are replaced as a whole, so keep the ones it already has.
    const message = await this.request<{ data: NylasMessage }>('GET', `/messages/${encodeURIComponent(messageId)}`);
    const current = message.data.folders ?? [];
    const update: { folders?: string[]; unread?: boolean } = {};
    if (!current.includes(labelId)) update.folders = [...current, labelId];
    // Newsletter and spam leave the unread count; the mail stays in the inbox.
    if (marksRead(group)) update.unread = false;
    if (Object.keys(update).length === 0) return;
    await this.request('PUT', `/messages/${encodeURIComponent(messageId)}`, update);
  }

  /**
   * Moves one message to Trash: out of the inbox, into the Trash folder. Never creates a folder and never deletes for good.
   * Used only for mail from a sender the owner unsubscribed from (see unsubscribe-enforcer.ts).
   */
  async moveToTrash(messageId: string): Promise<void> {
    const folders = await this.request<NylasList<NylasFolder>>('GET', '/folders');
    const all = folders.data ?? [];
    const isSystem = (f: NylasFolder, attribute: string, id: string) =>
      (f.attributes ?? []).some((a) => a.replace(/^\\/, '').toLowerCase() === attribute) || f.id.toUpperCase() === id;
    const trash = all.find((f) => isSystem(f, 'trash', 'TRASH'));
    if (!trash) throw new Error('Nylas mailbox has no Trash folder');
    const inboxId = all.find((f) => isSystem(f, 'inbox', 'INBOX'))?.id;

    const message = await this.request<{ data: NylasMessage }>('GET', `/messages/${encodeURIComponent(messageId)}`);
    const current = message.data.folders ?? [];
    if (current.includes(trash.id)) return;
    await this.request('PUT', `/messages/${encodeURIComponent(messageId)}`, {
      folders: [...current.filter((id) => id !== inboxId), trash.id],
      unread: false,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new MailboxRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    // Status only: response bodies can hold mail text and are never logged or surfaced.
    if (!res.ok) throw new Error(`Nylas ${method} ${path.split('?')[0]} responded ${res.status}`);
    return (await res.json()) as T;
  }
}
