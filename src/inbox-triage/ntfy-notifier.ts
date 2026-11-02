// ntfy-notifier.ts — the content-free push that wakes Command Hub (FR-ETP).
//
// The body is one of two fixed strings, never a sender, subject or text. The phone reads GET /phone/inbox for the rest.
// Command Hub cannot see ntfy's Priority header, so urgency travels in the body: "mail:urgent" asks for a notification,
// "mail" is a quiet refresh.

import type { TriageGroup } from './types.js';
import type { TriageNotifier } from './watcher.js';

/** ntfy priorities: 4 = high (loud), 2 = low (quiet). Urgent is loud; drafted and seen are quiet (FR-ETP-2). */
const PRIORITY: Record<TriageGroup, string> = { urgent: '4', drafted: '2', seen: '2' };

/** What the phone receives. Fixed strings only; Command Hub keys off these exactly. */
const BODY: Record<TriageGroup, string> = { urgent: 'mail:urgent', drafted: 'mail', seen: 'mail' };

export class NtfyNotifier implements TriageNotifier {
  constructor(
    /** The full topic address, e.g. https://ntfy.example.com/curia-mail. */
    private readonly topicUrl: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notify(group: TriageGroup): Promise<void> {
    const headers: Record<string, string> = { Priority: PRIORITY[group], Title: 'inbox' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(this.topicUrl, { method: 'POST', headers, body: BODY[group] });
    // Only the status is reported; the response body is not needed.
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  }
}
