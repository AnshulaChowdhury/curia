// ntfy-notifier.ts — the content-free push that wakes Command Hub (FR-ETP).
//
// The body is a fixed word, never a sender, subject or text. The phone reads GET /phone/inbox for the rest.

import type { TriageGroup } from './types.js';
import type { TriageNotifier } from './watcher.js';

/** ntfy priorities: 4 = high (loud), 2 = low (quiet). Urgent is loud; drafted and seen are quiet (FR-ETP-2). */
const PRIORITY: Record<TriageGroup, string> = { urgent: '4', drafted: '2', seen: '2' };

export class NtfyNotifier implements TriageNotifier {
  constructor(
    private readonly serverUrl: string,
    private readonly topic: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notify(group: TriageGroup): Promise<void> {
    const url = `${this.serverUrl.replace(/\/+$/, '')}/${encodeURIComponent(this.topic)}`;
    const headers: Record<string, string> = { Priority: PRIORITY[group], Title: 'inbox' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(url, { method: 'POST', headers, body: 'mail' });
    // Only the status is reported; the response body is not needed.
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  }
}
