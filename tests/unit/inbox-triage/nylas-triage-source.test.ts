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
      if (url.endsWith('/folders')) return json({ data: [{ id: 'L2', name: '📌 Seen' }] });
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
      if (init.method === 'POST') return json({ data: { id: 'NEW', name: '🚨 Urgent' } });
      if (url.endsWith('/folders')) return json({ data: [] });
      return json({ data: { id: 'm1', folders: ['INBOX'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'urgent');
    expect(calls.find(([m]) => m === 'POST')![2]).toEqual({ name: '🚨 Urgent' });
    expect(calls.find(([m]) => m === 'PUT')![2]).toEqual({ folders: ['INBOX', 'NEW'] });
  });

  it('does not write when the message already carries the label', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/folders')) return json({ data: [{ id: 'L1', name: '🚨 Urgent' }] });
      return json({ data: { id: 'm1', folders: ['INBOX', 'L1'] } });
    }) as unknown as typeof fetch;
    await new NylasTriageSource('moonray', 'k', 'g', fetchImpl).applyLabel('m1', 'urgent');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, i]) => (i as RequestInit).method === 'PUT')).toBe(false);
  });

  it('reports only the status on failure, never the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret mail text', { status: 500 })) as unknown as typeof fetch;
    await expect(new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged()).rejects.toThrow(/500/);
    await expect(new NylasTriageSource('moonray', 'k', 'g', fetchImpl).listUntagged()).rejects.not.toThrow(/secret/);
  });
});
