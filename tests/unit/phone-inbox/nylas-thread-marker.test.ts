import { describe, expect, it, vi } from 'vitest';
import { NylasThreadMarker, loadPhoneThreadMarker } from '../../../src/phone-inbox/nylas-thread-marker.js';
import { MailboxRateLimitedError } from '../../../src/phone-inbox/phone-inbox-service.js';

const reply = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers });

describe('NylasThreadMarker', () => {
  it('sends only { unread: false } to the thread, nothing else', async () => {
    const fetchImpl = vi.fn(async (_u: string, _i: RequestInit) => reply(200));
    await new NylasThreadMarker('k', 'g/1', fetchImpl as unknown as typeof fetch).markRead('t 1');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.us.nylas.com/v3/grants/g%2F1/threads/t%201');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ unread: false });
  });

  it('counts a thread that no longer exists as done', async () => {
    expect(await new NylasThreadMarker('k', 'g', (async () => reply(404)) as unknown as typeof fetch).markRead('t')).toBe(true);
  });

  it('throws a rate-limit error with the wait, and a status-only error otherwise', async () => {
    const limited = new NylasThreadMarker('k', 'g', (async () => reply(429, { 'retry-after': '7' })) as unknown as typeof fetch);
    await expect(limited.markRead('t')).rejects.toMatchObject({ retryAfterSeconds: 7 });
    await expect(limited.markRead('t')).rejects.toBeInstanceOf(MailboxRateLimitedError);
    const broken = new NylasThreadMarker('k', 'g', (async () => reply(500)) as unknown as typeof fetch);
    await expect(broken.markRead('t')).rejects.toMatchObject({ status: 500 });
  });

  it('is null for a mailbox with no grant', async () => {
    const secrets = { get: async (n: string) => (n === 'nylas_api_key' ? 'k' : null) };
    expect(await loadPhoneThreadMarker(secrets, 'moonray')).toBeNull();
  });
});
