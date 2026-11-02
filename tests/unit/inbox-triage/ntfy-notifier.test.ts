import { describe, expect, it, vi } from 'vitest';
import { NtfyNotifier } from '../../../src/inbox-triage/ntfy-notifier.js';

describe('NtfyNotifier', () => {
  it('posts a fixed, content-free body with a loud priority for urgent', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    await new NtfyNotifier('https://ntfy.example/my-topic', 'tok', fetchImpl).notify('urgent');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ntfy.example/my-topic');
    expect(init.body).toBe('mail');
    expect((init.headers as Record<string, string>).Priority).toBe('4');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it.each(['drafted', 'seen'] as const)('is quiet for %s and sends no auth header without a token', async (group) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    await new NtfyNotifier('https://ntfy.example/t', null, fetchImpl).notify(group);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Priority).toBe('2');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws on a non-2xx status', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(new NtfyNotifier('https://ntfy.example/t', null, fetchImpl).notify('seen')).rejects.toThrow('500');
  });
});
