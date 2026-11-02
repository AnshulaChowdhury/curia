// nylas-triage-source.ts — one Nylas mailbox as a TriageSource.
//
// Reads unread inbox mail that carries no triage label, with a short preview but never a body, and writes only
// the triage label, plus "read" for newsletter and spam mail (FR-ETW-5). Uses fetch directly, like
// src/phone-inbox/nylas-mailbox.ts.

import { NYLAS_REGIONS, type NylasRegion } from '../phone-inbox/nylas-mailbox.js';
import { TRIAGE_LABELS, marksRead, triageGroupOfLabel, type TriageCandidate, type TriageGroup } from './types.js';
import type { TriageSource } from './watcher.js';

interface NylasFolder { id: string; name?: string }
interface NylasMessage {
  id: string;
  thread_id?: string;
  subject?: string;
  snippet?: string;
  date?: number;
  from?: Array<{ name?: string; email?: string }>;
  folders?: string[];
}
interface NylasList<T> { data?: T[] }

const LIST_LIMIT = 20;
const SNIPPET_MAX_CHARS = 400;
const EXCLUDED = new Set(['SPAM', 'TRASH', 'DRAFT', 'SENT']);

export class NylasTriageSource implements TriageSource {
  private readonly baseUrl: string;

  constructor(
    readonly accountId: string,
    private readonly apiKey: string,
    grantId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    region: NylasRegion = 'us',
  ) {
    this.baseUrl = `${NYLAS_REGIONS[region]}/v3/grants/${encodeURIComponent(grantId)}`;
  }

  async listUntagged(): Promise<TriageCandidate[]> {
    const folders = await this.request<NylasList<NylasFolder>>('GET', '/folders');
    const nameById = new Map((folders.data ?? []).map((f) => [f.id, f.name ?? ''] as const));
    const query = new URLSearchParams({ in: 'INBOX', unread: 'true', limit: String(LIST_LIMIT) });
    const messages = await this.request<NylasList<NylasMessage>>('GET', `/messages?${query}`);

    const out: TriageCandidate[] = [];
    for (const m of messages.data ?? []) {
      const names = (m.folders ?? []).map((id) => nameById.get(id) ?? id);
      if (names.some((n) => EXCLUDED.has(n.toUpperCase()))) continue;
      if (names.some((n) => triageGroupOfLabel(n) !== null)) continue; // already tagged (current or earlier label names)
      out.push({
        accountId: this.accountId,
        messageId: m.id,
        threadId: m.thread_id ?? '',
        from: m.from?.[0]?.name || m.from?.[0]?.email || '',
        subject: m.subject ?? '',
        snippet: (m.snippet ?? '').slice(0, SNIPPET_MAX_CHARS),
        receivedAt: m.date ?? 0,
      });
    }
    return out;
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
    // Status only: response bodies can hold mail text and are never logged or surfaced.
    if (!res.ok) throw new Error(`Nylas ${method} ${path.split('?')[0]} responded ${res.status}`);
    return (await res.json()) as T;
  }
}
