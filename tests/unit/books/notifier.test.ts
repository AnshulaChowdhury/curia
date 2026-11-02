import { describe, it, expect } from 'vitest';
import { BooksNotifier, ReviewersError, validateReviewers } from '../../../src/books/notifier.js';
import { createSilentLogger } from '../../../src/logger.js';

function vault(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { m, get: async (n: string) => m.get(n) ?? null, set: async (n: string, v: string) => void m.set(n, v) };
}

describe('validateReviewers', () => {
  it('cleans a good list', () => {
    expect(validateReviewers([{ name: ' Anshula ', email: 'a@x.com', ntfyTopic: 'books_alerts' }, { name: 'Krisette' }])).toEqual([
      { name: 'Anshula', email: 'a@x.com', ntfyTopic: 'books_alerts' }, { name: 'Krisette' },
    ]);
  });
  it('rejects a missing name, a bad email, a bad topic, a non-https address, and too many', () => {
    for (const bad of [[{ name: '' }], [{ name: 'A', email: 'nope' }], [{ name: 'A', ntfyTopic: 'has space' }], [{ name: 'A', ntfyTopic: 'http://x.test/t' }], 'x', Array.from({ length: 11 }, () => ({ name: 'A' }))]) {
      expect(() => validateReviewers(bad)).toThrow(ReviewersError);
    }
  });
});

describe('BooksNotifier', () => {
  const reviewers = JSON.stringify([{ name: 'Anshula', ntfyTopic: 'books_a' }, { name: 'Krisette', ntfyTopic: 'https://ntfy.other.test/k' }, { name: 'NoTopic' }]);
  function setup(responses: Array<number | Error> = [200, 200]) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const r = responses.shift() ?? 200;
      if (r instanceof Error) throw r;
      return { ok: r < 400, status: r };
    }) as unknown as typeof fetch;
    const v = vault({ books_reviewers: reviewers, inbox_triage_ntfy_url: 'https://ntfy.moonray.test/curia-mail', inbox_triage_ntfy_token: 'tk' });
    return { n: new BooksNotifier(v, createSilentLogger(), fetchImpl), calls, v };
  }

  it('pushes to each reviewer with a topic, using the triage ntfy server for bare topic names', async () => {
    const { n, calls } = setup();
    expect(await n.notify('Books: files overdue', 'Missing for: rbc-x')).toBe(2);
    expect(calls.map(c => c.url)).toEqual(['https://ntfy.moonray.test/books_a', 'https://ntfy.other.test/k']);
    expect(calls[0]!.headers.Authorization).toBe('Bearer tk');
    expect(calls[0]!.body).toBe('Missing for: rbc-x');
  });
  it('keeps the title header plain ASCII', async () => {
    const { n, calls } = setup();
    await n.notify('Books – files due ✓', 'x');
    expect(calls[0]!.headers.Title).toMatch(/^[\x20-\x7e]+$/);
  });
  it('counts only accepted pushes and survives a network error', async () => {
    const { n } = setup([500, new Error('offline')]);
    expect(await n.notify('t', 'm')).toBe(0);
  });
  it('sends nothing for a bare topic when no ntfy server is set up', async () => {
    const v = vault({ books_reviewers: JSON.stringify([{ name: 'A', ntfyTopic: 'books_a' }]) });
    const n = new BooksNotifier(v, createSilentLogger(), (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch);
    expect(await n.notify('t', 'm')).toBe(0);
  });
  it('saves a validated list and refuses a bad one without changing the old one', async () => {
    const { n, v } = setup();
    await n.setReviewers([{ name: 'New', ntfyTopic: 'newtopic' }]);
    expect(JSON.parse(v.m.get('books_reviewers')!)).toEqual([{ name: 'New', ntfyTopic: 'newtopic' }]);
    await expect(n.setReviewers([{ name: '' }])).rejects.toBeInstanceOf(ReviewersError);
    expect(JSON.parse(v.m.get('books_reviewers')!)).toHaveLength(1);
  });
  it('treats an unreadable saved list as empty', async () => {
    const n = new BooksNotifier(vault({ books_reviewers: '{not json' }), createSilentLogger());
    expect(await n.getReviewers()).toEqual([]);
  });
});
