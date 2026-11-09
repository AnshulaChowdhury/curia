import { describe, expect, it, vi } from 'vitest';
import { NylasUnsubscribeReader, loadUnsubscribeReader } from '../../../src/phone-inbox/nylas-unsubscribe.js';
import { MailboxRateLimitedError } from '../../../src/phone-inbox/phone-inbox-service.js';

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const reader = (impl: (u: string, i: RequestInit) => Promise<Response>) => new NylasUnsubscribeReader('k', 'g/1', impl as unknown as typeof fetch);

describe('NylasUnsubscribeReader', () => {
  it('asks for the headers of one message and finds the unsubscribe ones, ignoring case', async () => {
    const fetchImpl = vi.fn(async (_u: string, _i: RequestInit) => json({ from: [{ email: 'News@X.com' }], headers: [
      { name: 'Subject', value: 'x' }, { name: 'List-Unsubscribe', value: '<https://x.com/u>' }, { name: 'list-unsubscribe-post', value: 'List-Unsubscribe=One-Click' },
    ] }));
    expect(await reader(fetchImpl).read('m 1')).toEqual({ listUnsubscribe: '<https://x.com/u>', listUnsubscribePost: 'List-Unsubscribe=One-Click', fromAddress: 'news@x.com' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.us.nylas.com/v3/grants/g%2F1/messages/m%201?fields=include_headers');
    expect(init.method).toBeUndefined(); // a GET
  });

  it('gives nulls when the headers are absent, and null for a missing message', async () => {
    expect(await reader(async () => json({})).read('m')).toEqual({ listUnsubscribe: null, listUnsubscribePost: null, fromAddress: null });
    expect(await reader(async () => new Response('{}', { status: 404 })).read('m')).toBeNull();
  });

  it('throws a rate-limit error with the wait, and a status-only error otherwise', async () => {
    const limited = reader(async () => new Response('{}', { status: 429, headers: { 'retry-after': '9' } }));
    await expect(limited.read('m')).rejects.toBeInstanceOf(MailboxRateLimitedError);
    await expect(reader(async () => new Response('{}', { status: 500 })).read('m')).rejects.toMatchObject({ status: 500 });
  });

  it('is null for a mailbox with no grant', async () => {
    const secrets = { get: async (n: string) => (n === 'nylas_api_key' ? 'k' : null) };
    expect(await loadUnsubscribeReader(secrets, 'moonray')).toBeNull();
    expect(await loadUnsubscribeReader({ get: async (n: string) => (n === 'nylas_region' ? 'us' : 'v') }, 'work-outlook')).toBeInstanceOf(NylasUnsubscribeReader);
  });
});
