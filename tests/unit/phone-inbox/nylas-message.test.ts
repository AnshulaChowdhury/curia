import { describe, it, expect, vi } from 'vitest';
import { MailboxRateLimitedError } from '../../../src/phone-inbox/phone-inbox-service.js';
import { NylasMailboxError } from '../../../src/phone-inbox/nylas-mailbox.js';
import { MAX_BODY_CHARS, NylasMessageReader, capText, loadPhoneMessageReader } from '../../../src/phone-inbox/nylas-message.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function reader(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch;
  return { r: new NylasMessageReader('key', 'grant 1', fetchImpl), fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
}

describe('capText', () => {
  it('leaves short text alone', () => {
    expect(capText('hello')).toEqual({ body: 'hello', truncated: false });
  });
  it('cuts at the limit and flags it', () => {
    const out = capText('a'.repeat(MAX_BODY_CHARS + 5));
    expect(out.body).toHaveLength(MAX_BODY_CHARS);
    expect(out.truncated).toBe(true);
  });
  it('never leaves half an emoji at the cut', () => {
    const out = capText('a'.repeat(MAX_BODY_CHARS - 1) + '😀' + 'tail');
    expect(out.truncated).toBe(true);
    expect(out.body).toBe('a'.repeat(MAX_BODY_CHARS - 1));
  });
});

describe('NylasMessageReader', () => {
  it('reads one message by id and converts the HTML to plain text', async () => {
    const { r, fetchImpl } = reader(() => json({ data: { id: 'm1', thread_id: 't1', body: '<div>Hi <b>Dana</b></div><script>x()</script><p>Thanks</p>' } }));
    const out = await r.read('t1', 'm 1');
    expect(out?.truncated).toBe(false);
    expect(out?.body).toContain('Hi Dana');
    expect(out?.body).toContain('Thanks');
    expect(out?.body).not.toContain('x()');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.us.nylas.com/v3/grants/grant%201/messages/m%201');
    expect(init.method).toBe('GET');
  });

  it('answers null for a message that belongs to another thread', async () => {
    const { r } = reader(() => json({ data: { id: 'm1', thread_id: 'other', body: 'secret' } }));
    expect(await r.read('t1', 'm1')).toBeNull();
  });

  it('without a messageId, returns the newest message that we did not send', async () => {
    const { r, fetchImpl } = reader(() => json({
      data: [
        { id: 'sent', date: 300, folders: ['SENT'], body: 'my reply' },
        { id: 'new', date: 200, folders: ['INBOX'], body: 'their newest' },
        { id: 'old', date: 100, folders: ['INBOX'], body: 'their first' },
        { id: 'draft', date: 400, folders: ['DRAFT'], body: 'unsent' },
      ],
    }));
    expect((await r.read('t1'))?.body).toBe('their newest');
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain('/messages?');
    expect(url).toContain('thread_id=t1');
    expect(url).toContain('limit=10');
  });

  it('is null when the thread has only our own mail, or nothing', async () => {
    expect(await reader(() => json({ data: [{ id: 's', folders: ['SENT'], body: 'x' }] })).r.read('t1')).toBeNull();
    expect(await reader(() => json({ data: [] })).r.read('t1')).toBeNull();
  });

  it('falls back to the snippet when there is no body', async () => {
    const { r } = reader(() => json({ data: { id: 'm1', thread_id: 't1', snippet: 'short preview' } }));
    expect((await r.read('t1', 'm1'))?.body).toBe('short preview');
  });

  it('treats Nylas 404 as no such email', async () => {
    const { r } = reader(() => json({}, 404));
    expect(await r.read('t1', 'gone')).toBeNull();
  });

  it('reports a rate limit with its Retry-After, and other failures by status only', async () => {
    await expect(reader(() => json({}, 429, { 'retry-after': '12' })).r.read('t1', 'm1'))
      .rejects.toMatchObject({ name: 'MailboxRateLimitedError', retryAfterSeconds: 12 });
    await expect(reader(() => json({}, 429)).r.read('t1', 'm1')).rejects.toBeInstanceOf(MailboxRateLimitedError);
    const err = await reader(() => new Response('SECRET BODY IN ERROR', { status: 500 })).r.read('t1', 'm1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NylasMailboxError);
    expect((err as Error).message).toContain('500');
    expect((err as Error).message).not.toContain('SECRET');
  });
});

describe('loadPhoneMessageReader', () => {
  const vault = (v: Record<string, string>) => ({ get: async (k: string) => v[k] ?? null });

  it('is null without a key or without a grant for that mailbox', async () => {
    expect(await loadPhoneMessageReader(vault({ phone_inbox_grant_moonray: 'g' }), 'moonray')).toBeNull();
    expect(await loadPhoneMessageReader(vault({ nylas_api_key: 'k' }), 'moonray')).toBeNull();
  });

  it('reads the grant for work-outlook from the work_outlook secret', async () => {
    const r = await loadPhoneMessageReader(vault({ nylas_api_key: 'k', phone_inbox_grant_work_outlook: 'g' }), 'work-outlook');
    expect(r).toBeInstanceOf(NylasMessageReader);
  });

  it('refuses a bad region rather than sending the key to a guessed host', async () => {
    await expect(loadPhoneMessageReader(vault({ nylas_api_key: 'k', nylas_region: 'evil', phone_inbox_grant_moonray: 'g' }), 'moonray')).rejects.toThrow(/nylas_region/);
  });
});
