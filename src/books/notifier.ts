// notifier.ts — tells the books reviewers something needs attention (ntfy push).
//
// Reviewers live in the vault (`books_reviewers`), edited on Settings → API connections. A reviewer's ntfy topic is a
// bare topic name (sent to the ntfy server already set up for inbox triage) or a full https address. Text is built by
// the caller and holds only account ids, the week and which check fired: never amounts, bank text or file contents.
//
// Email to reviewers is not sent from here yet: the repo's email path needs an agent/skill context (outbound gateway),
// which a plain service does not have. See docs/dev/books-monitor.md.

import type { Logger } from '../logger.js';

const REVIEWERS_SECRET = 'books_reviewers';
const TRIAGE_URL_SECRET = 'inbox_triage_ntfy_url';
const TRIAGE_TOKEN_SECRET = 'inbox_triage_ntfy_token';
const MAX_REVIEWERS = 10;

export interface Reviewer {
  name: string;
  email?: string;
  ntfyTopic?: string;
}

export interface NotifierSecrets {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

export class ReviewersError extends Error {}

const TOPIC_RX = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RX = /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{1,50}$/;

/** Checks a submitted list; returns the cleaned reviewers or throws ReviewersError with the reason. */
export function validateReviewers(input: unknown): Reviewer[] {
  if (!Array.isArray(input)) throw new ReviewersError('reviewers must be a list');
  if (input.length > MAX_REVIEWERS) throw new ReviewersError(`at most ${MAX_REVIEWERS} reviewers`);
  return input.map((raw, i) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > 100) throw new ReviewersError(`reviewer ${i + 1}: enter a name (up to 100 characters)`);
    const out: Reviewer = { name };
    if (typeof r.email === 'string' && r.email.trim()) {
      if (!EMAIL_RX.test(r.email.trim())) throw new ReviewersError(`${name}: that email address does not look right`);
      out.email = r.email.trim();
    }
    if (typeof r.ntfyTopic === 'string' && r.ntfyTopic.trim()) {
      const t = r.ntfyTopic.trim();
      const isUrl = /^https:\/\/[^\s]{1,300}$/.test(t);
      if (!isUrl && !TOPIC_RX.test(t)) throw new ReviewersError(`${name}: the ntfy topic is a name (letters, digits, - and _) or a full https address`);
      out.ntfyTopic = t;
    }
    return out;
  });
}

export class BooksNotifier {
  constructor(
    private readonly secrets: NotifierSecrets,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getReviewers(): Promise<Reviewer[]> {
    const raw = await this.secrets.get(REVIEWERS_SECRET);
    if (!raw) return [];
    try {
      return validateReviewers(JSON.parse(raw));
    } catch (err) {
      this.logger.error({ err }, 'books: the saved reviewers list is unreadable');
      return [];
    }
  }

  async setReviewers(input: unknown): Promise<Reviewer[]> {
    const reviewers = validateReviewers(input);
    await this.secrets.set(REVIEWERS_SECRET, JSON.stringify(reviewers));
    return reviewers;
  }

  /** Pushes `title`/`message` to every reviewer with an ntfy topic. Returns how many pushes were accepted. */
  async notify(title: string, message: string): Promise<number> {
    const reviewers = await this.getReviewers();
    const base = await this.baseUrl();
    const token = (await this.secrets.get(TRIAGE_TOKEN_SECRET))?.trim() || null;
    let sent = 0;
    for (const r of reviewers) {
      const url = this.topicUrl(r.ntfyTopic, base);
      if (!url) continue;
      try {
        const headers: Record<string, string> = { Title: title.replace(/[^\x20-\x7e]/g, '?'), Priority: '4', Tags: 'books' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await this.fetchImpl(url, { method: 'POST', headers, body: message });
        if (res.ok) sent++;
        else this.logger.warn({ status: res.status, reviewer: r.name }, 'books: ntfy refused a notification');
      } catch (err) {
        this.logger.warn({ err, reviewer: r.name }, 'books: could not reach ntfy');
      }
    }
    if (reviewers.length === 0) this.logger.warn({ title }, 'books: a notification is due but no reviewers are set up');
    return sent;
  }

  private async baseUrl(): Promise<string | null> {
    const full = (await this.secrets.get(TRIAGE_URL_SECRET))?.trim();
    if (!full) return null;
    try {
      return new URL(full).origin;
    } catch {
      return null;
    }
  }

  private topicUrl(topic: string | undefined, base: string | null): string | null {
    if (!topic) return null;
    if (topic.startsWith('https://')) return topic;
    return base ? `${base}/${topic}` : null;
  }
}
