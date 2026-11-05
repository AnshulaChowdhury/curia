import { describe, expect, it, vi } from 'vitest';
import { NylasTriageSource } from '../../../src/inbox-triage/nylas-triage-source.js';

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe('NylasTriageSource', () => {
  it('lists unread inbox mail without a triage label, skipping spam, and clips the preview', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/folders')) return json({ data: [{ id: 'INBOX', name: 'INBOX' }, { id: 'L1', name: '🚨 Urgent' }, { id: 'SPAM', name: 'SPAM' }] });
      return json({ data: [
        { id: 'm1', thread_id: 't1', subject: 'Hello', snippet: 'x'.repeat(900), date: 5, from: [{ name: 'Dana', email: 'd@x.com' }], folders: ['INBOX'] },
        { id: 'm2', folders: ['INBOX', 'L1'] },
        { id: 'm3', folders: ['SPAM'] },
      ] });
    }) as unknown as typeof fetch;
    const out = await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged();
    expect(out.map((c) => c.messageId)).toEqual(['m1']);
    expect(out[0]!.snippet).toHaveLength(400);
    expect(out[0]!.from).toBe('Dana');
  });

  it('applies an existing label and keeps the message\'s other folders', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body as string) : undefined]);
      if (url.endsWith('/folders')) return json({ data: [{ id: 'L2', name: 'FYI, no action needed' }] });
      return json({ data: { id: 'm1', folders: ['INBOX', 'UNREAD'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'seen');
    const put = calls.find(([m]) => m === 'PUT')!;
    expect(put[2]).toEqual({ folders: ['INBOX', 'UNREAD', 'L2'] });
  });

  it('creates the label when it does not exist', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body as string) : undefined]);
      if (init.method === 'POST') return json({ data: { id: 'NEW', name: 'Urgent' } });
      if (url.endsWith('/folders')) return json({ data: [] });
      return json({ data: { id: 'm1', folders: ['INBOX'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'urgent');
    expect(calls.find(([m]) => m === 'POST')![2]).toEqual({ name: 'Urgent' });
    expect(calls.find(([m]) => m === 'PUT')![2]).toEqual({ folders: ['INBOX', 'NEW'] });
  });

  it('does not write when the message already carries the label', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/folders')) return json({ data: [{ id: 'L1', name: 'Urgent' }] });
      return json({ data: { id: 'm1', folders: ['INBOX', 'L1'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'urgent');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, i]) => (i as RequestInit).method === 'PUT')).toBe(false);
  });

  it('treats mail with an earlier-named triage label as already tagged', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/folders')) return json({ data: [{ id: 'INBOX', name: 'INBOX' }, { id: 'O1', name: '✍️ Drafted' }, { id: 'N1', name: 'Newsletter' }, { id: 'Y1', name: 'Likely spam' }] });
      return json({ data: [
        { id: 'a', folders: ['INBOX', 'O1'] },
        { id: 'b', folders: ['INBOX', 'N1'] },
        { id: 'c', folders: ['INBOX', 'Y1'] },
        { id: 'd', folders: ['INBOX'] },
      ] });
    }) as unknown as typeof fetch;
    const out = await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged();
    expect(out.map((c) => c.messageId)).toEqual(['d']);
  });

  it('does not reuse an earlier-named label: it creates the new name', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body as string) : undefined]);
      if (init.method === 'POST') return json({ data: { id: 'NEW', name: 'Needs a reply' } });
      if (url.endsWith('/folders')) return json({ data: [{ id: 'OLD', name: '✍️ Drafted' }] });
      return json({ data: { id: 'm1', folders: ['INBOX'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'drafted');
    expect(calls.find(([m]) => m === 'POST')![2]).toEqual({ name: 'Needs a reply' });
    expect(calls.find(([m]) => m === 'PUT')![2]).toEqual({ folders: ['INBOX', 'NEW'] });
  });

  it('labels newsletter mail and marks it read in the same write', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body as string) : undefined]);
      if (url.endsWith('/folders')) return json({ data: [{ id: 'N1', name: 'Newsletter' }] });
      return json({ data: { id: 'm1', folders: ['INBOX', 'UNREAD'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'newsletter');
    expect(calls.find(([m]) => m === 'PUT')![2]).toEqual({ folders: ['INBOX', 'UNREAD', 'N1'], unread: false });
  });

  it('never applies Gmail\'s own SPAM folder: the spam label is "Likely spam", created if missing', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body as string) : undefined]);
      if (init.method === 'POST') return json({ data: { id: 'LS', name: 'Likely spam' } });
      if (url.endsWith('/folders')) return json({ data: [{ id: 'SPAM', name: 'SPAM' }, { id: 'INBOX', name: 'INBOX' }] });
      return json({ data: { id: 'm1', folders: ['INBOX'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'spam');
    expect(calls.find(([m]) => m === 'POST')![2]).toEqual({ name: 'Likely spam' });
    const put = calls.find(([m]) => m === 'PUT')![2] as { folders: string[]; unread: boolean };
    expect(put.folders).toEqual(['INBOX', 'LS']);
    expect(put.folders).not.toContain('SPAM');
    expect(put.unread).toBe(false);
  });

  it('marks already-labelled newsletter mail read without touching its folders', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body as string) : undefined]);
      if (url.endsWith('/folders')) return json({ data: [{ id: 'N1', name: 'Newsletter' }] });
      return json({ data: { id: 'm1', folders: ['INBOX', 'N1'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'newsletter');
    expect(calls.find(([m]) => m === 'PUT')![2]).toEqual({ unread: false });
  });

  it('reports only the status on failure, never the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret mail text', { status: 500 })) as unknown as typeof fetch;
    await expect(new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged()).rejects.toThrow(/500/);
    await expect(new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged()).rejects.not.toThrow(/secret/);
  });

  it('includes mail the owner already read, marks it, and starts at the cut-off date', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/folders')) return json({ data: [{ id: 'INBOX', name: 'INBOX' }] });
      return json({ data: [{ id: 'r', folders: ['INBOX'], unread: false }, { id: 'u', folders: ['INBOX'], unread: true }] });
    }) as unknown as typeof fetch;
    const out = await new NylasTriageSource('moonray', 'k', 'g', fetchImpl, 'us', 1_793_505_600).listUntagged();
    expect(out.map((c) => [c.messageId, c.unread])).toEqual([['r', false], ['u', true]]);
    const listing = urls.find((u) => u.includes('/messages'))!;
    expect(listing).toContain('received_after=1793505600');
    expect(listing).not.toContain('unread=');
  });

  it('reads further pages when the newest mail is all handled, and skips known ids', async () => {
    const pages = [
      { data: [{ id: 'k1', folders: ['INBOX'] }, { id: 'k2', folders: ['INBOX'] }], next_cursor: 'p2' },
      { data: [{ id: 'new', folders: ['INBOX'] }] },
    ];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/folders')) return json({ data: [{ id: 'INBOX', name: 'INBOX' }] });
      urls.push(url);
      return json(pages.shift());
    }) as unknown as typeof fetch;
    const out = await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged(async (id) => id.startsWith('k'));
    expect(out.map((c) => c.messageId)).toEqual(['new']);
    expect(urls[1]).toContain('page_token=p2');
  });

  describe('resuming from the last successful triage', () => {
    const mailbox = (urls: string[]) => vi.fn(async (url: string) => {
      if (url.includes('/folders')) return json({ data: [{ id: 'INBOX', name: 'INBOX' }] });
      urls.push(url);
      return json({ data: [{ id: 'a', folders: ['INBOX'] }] });
    }) as unknown as typeof fetch;
    const after = (url: string) => Number(new URL(url).searchParams.get('received_after'));
    const progressWith = (saved: number | null) => ({ get: vi.fn(async (_id: string) => saved), set: vi.fn(async (_id: string, _at: number) => {}) });

    it('starts one hour before the saved mark', async () => {
      const urls: string[] = [];
      const progress = progressWith(1_800_000_000_000);
      await new NylasTriageSource('moonray', 'k', 'g', mailbox(urls), 'us', 0, progress).listUntagged();
      expect(after(urls[0]!)).toBe(1_800_000_000 - 3600);
      expect(progress.get).toHaveBeenCalledWith('moonray');
    });

    it('looks back 24 hours when the mailbox has never been triaged', async () => {
      const urls: string[] = [];
      await new NylasTriageSource('moonray', 'k', 'g', mailbox(urls), 'us', 0, progressWith(null)).listUntagged();
      const now = Date.now() / 1000;
      expect(after(urls[0]!)).toBeGreaterThan(now - 24 * 3600 - 5);
      expect(after(urls[0]!)).toBeLessThan(now - 24 * 3600 + 5);
    });

    it('never starts before the explicit floor', async () => {
      const urls: string[] = [];
      await new NylasTriageSource('moonray', 'k', 'g', mailbox(urls), 'us', 1_900_000_000, progressWith(1_800_000_000_000)).listUntagged();
      expect(after(urls[0]!)).toBe(1_900_000_000);
    });

    it('saves the time the listing began once the watcher handled everything, and the next listing starts there', async () => {
      const urls: string[] = [];
      const progress = progressWith(1_800_000_000_000);
      const source = new NylasTriageSource('moonray', 'k', 'g', mailbox(urls), 'us', 0, progress);
      const before = Date.now();
      await source.listUntagged();
      await source.commitProgress(true);
      const saved = progress.set.mock.calls[0]![1] as number;
      expect(progress.set.mock.calls[0]![0]).toBe('moonray');
      expect(saved).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      await source.listUntagged();
      expect(after(urls[1]!)).toBe(saved / 1000 - 3600);
    });

    it('keeps the old mark when some mail was left unhandled', async () => {
      const urls: string[] = [];
      const progress = progressWith(1_800_000_000_000);
      const source = new NylasTriageSource('moonray', 'k', 'g', mailbox(urls), 'us', 0, progress);
      await source.listUntagged();
      await source.commitProgress(false);
      await source.listUntagged();
      expect(progress.set).not.toHaveBeenCalled();
      expect(after(urls[1]!)).toBe(after(urls[0]!));
    });

    it('keeps the old mark when the listing stopped before the end of the window', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('/folders')) return json({ data: [{ id: 'INBOX', name: 'INBOX' }] });
        return json({ data: [{ id: `m${Math.random()}`, folders: ['INBOX'] }], next_cursor: 'more' });
      }) as unknown as typeof fetch;
      const progress = progressWith(1_800_000_000_000);
      const source = new NylasTriageSource('moonray', 'k', 'g', fetchImpl, 'us', 0, progress);
      await source.listUntagged(async () => true); // everything known, so it pages to the cap without finding the end
      await source.commitProgress(true);
      expect(progress.set).not.toHaveBeenCalled();
    });

    it('does not move the mark after a failed listing', async () => {
      const fetchImpl = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
      const progress = progressWith(1_800_000_000_000);
      const source = new NylasTriageSource('moonray', 'k', 'g', fetchImpl, 'us', 0, progress);
      await expect(source.listUntagged()).rejects.toThrow();
      await source.commitProgress(true);
      expect(progress.set).not.toHaveBeenCalled();
    });
  });

  it('throws a rate-limit error carrying the wait when Nylas answers 429', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 429, headers: { 'retry-after': '42' } })) as unknown as typeof fetch;
    await expect(new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged()).rejects.toMatchObject({ retryAfterSeconds: 42 });
  });

  describe('moveToTrash', () => {
    const run = async (folders: unknown[], message: unknown) => {
      const calls: Array<[string, string, unknown]> = [];
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body as string) : undefined]);
        if (url.endsWith('/folders')) return json({ data: folders });
        return json({ data: message });
      }) as unknown as typeof fetch;
      const source = new NylasTriageSource('moonray', 'k', 'g', fetchImpl);
      return { calls, source };
    };

    it('takes the message out of the inbox, keeps its labels, and puts it in Trash', async () => {
      const { calls, source } = await run(
        [{ id: 'INBOX', name: 'INBOX' }, { id: 'TRASH', name: 'TRASH' }, { id: 'L9', name: 'Likely spam' }],
        { id: 'm1', folders: ['INBOX', 'L9'] },
      );
      await source.moveToTrash('m1');
      expect(calls.find(([m]) => m === 'PUT')![2]).toEqual({ folders: ['L9', 'TRASH'], unread: false });
    });

    it('finds Trash by its \\Trash attribute on providers whose folder has another id', async () => {
      const { calls, source } = await run(
        [{ id: 'f-in', name: 'Inbox', attributes: ['\\Inbox'] }, { id: 'f-del', name: 'Deleted Items', attributes: ['\\Trash'] }],
        { id: 'm1', folders: ['f-in'] },
      );
      await source.moveToTrash('m1');
      expect(calls.find(([m]) => m === 'PUT')![2]).toEqual({ folders: ['f-del'], unread: false });
    });

    it('writes nothing when it is already in Trash, and never creates a folder when there is no Trash', async () => {
      const done = await run([{ id: 'TRASH', name: 'TRASH' }], { id: 'm1', folders: ['TRASH'] });
      await done.source.moveToTrash('m1');
      expect(done.calls.some(([m]) => m === 'PUT')).toBe(false);
      const none = await run([{ id: 'INBOX', name: 'INBOX' }], { id: 'm1', folders: ['INBOX'] });
      await expect(none.source.moveToTrash('m1')).rejects.toThrow(/no Trash folder/);
      expect(none.calls.some(([m]) => m === 'POST' || m === 'PUT')).toBe(false);
    });
  });
});
