import { describe, expect, it, vi } from 'vitest';
import { NewsletterBriefSource } from '../../../src/phone-brief/newsletter-source.js';
import type { NewsletterSummarizer } from '../../../src/phone-brief/summarizer.js';
import type { BriefContext } from '../../../src/phone-brief/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const CTX: BriefContext = { date: '2026-11-02', yesterday: { start: 1_000, end: 90_000 } };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

function vault(extra: Record<string, string> = {}) {
  const v: Record<string, string> = {
    nylas_api_key: 'key', phone_inbox_grant_moonray: 'g-moonray', phone_inbox_grant_personal: 'g-personal', ...extra,
  };
  return { get: async (k: string) => v[k] ?? null };
}

interface Mail { id: string; thread_id: string; subject: string; date: number; from: Array<{ name?: string; email?: string }>; body?: string }

/** A fake Nylas: per grant, a folder list and the newsletter mail; one body per message for the text reader. */
function nylas(byGrant: Record<string, { folders: Array<{ id: string; name: string }>; mail: Mail[] }>, failGrants: string[] = []) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const grant = decodeURIComponent(/grants\/([^/]+)/.exec(u)![1]!);
    if (failGrants.includes(grant)) return new Response('boom', { status: 500 });
    const box = byGrant[grant];
    if (!box) return json([]);
    if (u.includes('/folders')) return json(box.folders);
    const single = /\/messages\/([^/?]+)$/.exec(u);
    if (single) return json(box.mail.find((m) => m.id === decodeURIComponent(single[1]!)));
    return json(box.mail);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const summarizer = (fn: (text: string) => string | null | Promise<string | null> = (t) => `Summary of: ${t.slice(0, 20)}`): NewsletterSummarizer => ({
  summarize: vi.fn(async (t: string) => fn(t)),
});

const mail = (id: string, date: number, over: Partial<Mail> = {}): Mail => ({
  id, thread_id: `t-${id}`, subject: `Subject ${id}`, date, from: [{ name: `Sender ${id}`, email: `${id}@x.com` }], body: `Body of ${id}`, ...over,
});

describe('NewsletterBriefSource', () => {
  it('lists only the Newsletter label for yesterday, then summarises each from its text', async () => {
    const { fetchImpl, calls } = nylas({ 'g-moonray': { folders: [{ id: 'INBOX', name: 'INBOX' }, { id: 'N1', name: 'Newsletter' }], mail: [mail('a', 500)] } });
    const s = summarizer();
    const items = await new NewsletterBriefSource({ secrets: vault(), summarizer: s, logger, fetchImpl }).items(CTX);
    expect(items).toEqual([{ from: 'Sender a', subject: 'Subject a', text: 'Summary of: Body of a' }]);
    const list = calls.find((u) => u.includes('/messages?'))!;
    expect(list).toContain('in=N1');
    expect(list).toContain('received_after=1000');
    expect(list).toContain('received_before=90000');
    expect(s.summarize).toHaveBeenCalledWith('Body of a');
  });

  it('does not list mail when the mailbox has no Newsletter label', async () => {
    const { fetchImpl, calls } = nylas({ 'g-moonray': { folders: [{ id: 'INBOX', name: 'INBOX' }, { id: 'S', name: 'SPAM' }], mail: [mail('a', 500)] } });
    const items = await new NewsletterBriefSource({ secrets: vault(), summarizer: summarizer(), logger, fetchImpl }).items(CTX);
    expect(items).toEqual([]);
    expect(calls.some((u) => u.includes('/messages?'))).toBe(false);
  });

  it('merges mailboxes newest first and caps the section at 10', async () => {
    const many = Array.from({ length: 8 }, (_, i) => mail(`m${i}`, 100 + i));
    const more = Array.from({ length: 8 }, (_, i) => mail(`p${i}`, 200 + i));
    const { fetchImpl } = nylas({
      'g-moonray': { folders: [{ id: 'N1', name: 'Newsletter' }], mail: many },
      'g-personal': { folders: [{ id: 'N2', name: 'Newsletter' }], mail: more },
    });
    const items = await new NewsletterBriefSource({ secrets: vault(), summarizer: summarizer(), logger, fetchImpl }).items(CTX);
    expect(items).toHaveLength(10);
    expect(items[0]!.subject).toBe('Subject p7'); // newest of all
  });

  it('still sends sender and subject when the model gives no summary', async () => {
    const { fetchImpl } = nylas({ 'g-moonray': { folders: [{ id: 'N1', name: 'Newsletter' }], mail: [mail('a', 500)] } });
    const items = await new NewsletterBriefSource({ secrets: vault(), summarizer: summarizer(() => null), logger, fetchImpl }).items(CTX);
    expect(items).toEqual([{ from: 'Sender a', subject: 'Subject a', text: undefined }]);
  });

  it('survives the summarizer throwing, and an email with no text', async () => {
    const { fetchImpl } = nylas({ 'g-moonray': { folders: [{ id: 'N1', name: 'Newsletter' }], mail: [mail('a', 500), mail('b', 400, { body: '' })] } });
    const throwing = summarizer(() => { throw new Error('llm down'); });
    const items = await new NewsletterBriefSource({ secrets: vault(), summarizer: throwing, logger, fetchImpl }).items(CTX);
    expect(items.map((i) => i.subject)).toEqual(['Subject a', 'Subject b']);
    expect(items.every((i) => i.text === undefined)).toBe(true);
  });

  it('an unreachable mailbox only drops its own newsletters', async () => {
    const { fetchImpl } = nylas({ 'g-personal': { folders: [{ id: 'N2', name: 'Newsletter' }], mail: [mail('p', 300)] } }, ['g-moonray']);
    const items = await new NewsletterBriefSource({ secrets: vault(), summarizer: summarizer(), logger, fetchImpl }).items(CTX);
    expect(items.map((i) => i.subject)).toEqual(['Subject p']);
  });

  it('is empty with no Nylas key, an unknown region, or no grants; it never calls Nylas', async () => {
    for (const secrets of [
      { get: async () => null },
      vault({ nylas_region: 'evil' }),
      { get: async (k: string) => (k === 'nylas_api_key' ? 'key' : null) },
    ]) {
      const { fetchImpl } = nylas({});
      expect(await new NewsletterBriefSource({ secrets, summarizer: summarizer(), logger, fetchImpl }).items(CTX)).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('only issues GET requests', async () => {
    const { fetchImpl } = nylas({ 'g-moonray': { folders: [{ id: 'N1', name: 'Newsletter' }], mail: [mail('a', 500)] } });
    await new NewsletterBriefSource({ secrets: vault(), summarizer: summarizer(), logger, fetchImpl }).items(CTX);
    const methods = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => (init as RequestInit).method);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });
});
