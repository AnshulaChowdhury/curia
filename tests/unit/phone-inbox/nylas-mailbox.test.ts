import { describe, it, expect, vi } from 'vitest';
import { NylasMailbox, NylasMailboxError } from '../../../src/phone-inbox/nylas-mailbox.js';
import { loadPhoneInboxAccounts } from '../../../src/phone-inbox/accounts.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('NylasMailbox', () => {
  it('maps folder ids to names, asks only for unread inbox mail, and sends GETs with the bearer key', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/folders')) return jsonResponse({ data: [{ id: 'Label_9', name: '🚨 Urgent' }] });
      return jsonResponse({
        data: [{
          id: 'm1', thread_id: 't1', subject: 'Hi', date: 1000,
          from: [{ name: 'Dana', email: 'dana@example.com' }],
          folders: ['INBOX', 'Label_9'],
          body: 'SECRET BODY', snippet: 'SECRET SNIPPET',
        }],
      });
    });
    const mailbox = new NylasMailbox('key', 'grant/1', fetchMock as unknown as typeof fetch);

    const messages = await mailbox.unreadInbox();

    expect(messages).toEqual([
      { id: 'm1', threadId: 't1', subject: 'Hi', fromName: 'Dana', fromEmail: 'dana@example.com', date: 1000, folderNames: ['INBOX', '🚨 Urgent'] },
    ]);
    // Bodies and snippets are never carried through, even if Nylas sends them.
    expect(JSON.stringify(messages)).not.toContain('SECRET');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/grants/grant%2F1/'))).toBe(true);
    expect(urls.find((u) => u.includes('/messages'))).toContain('in=INBOX');
    expect(urls.find((u) => u.includes('/messages'))).toContain('unread=true');
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    }
  });

  it('talks to the EU host for an EU application, and the US host by default', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: [] }));
    await new NylasMailbox('key', 'g', fetchMock as unknown as typeof fetch, 'eu').sentSince(0);
    await new NylasMailbox('key', 'g', fetchMock as unknown as typeof fetch).sentSince(0);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/api\.eu\.nylas\.com\/v3\/grants\/g\//);
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/^https:\/\/api\.us\.nylas\.com\/v3\/grants\/g\//);
  });

  it('lists sent mail since a time', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: [{ id: 's1', thread_id: 't1', date: 2000 }] }));
    const sent = await new NylasMailbox('key', 'g', fetchMock as unknown as typeof fetch).sentSince(1500);
    expect(sent).toEqual([{ threadId: 't1', date: 2000 }]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('in=SENT');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('received_after=1500');
  });

  it('throws with the status only on an error response', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ error: 'bad key sk-123' }, 401));
    const err = await new NylasMailbox('key', 'g', fetchMock as unknown as typeof fetch).sentSince(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NylasMailboxError);
    expect((err as Error).message).not.toContain('sk-123');
  });
});

describe('loadPhoneInboxAccounts', () => {
  it('lists all three accounts, with a reader only where key and grant exist', async () => {
    const values: Record<string, string> = {
      nylas_api_key: 'key',
      phone_inbox_grant_moonray: 'g1',
      phone_inbox_address_moonray: 'ac@example.com',
      phone_inbox_address_personal: 'me@example.com',
    };
    const accounts = await loadPhoneInboxAccounts({ get: async (name: string) => values[name] ?? null });
    expect(accounts.map((a) => a.id)).toEqual(['personal', 'moonray', 'work-outlook']);
    expect(accounts.map((a) => a.address)).toEqual(['me@example.com', 'ac@example.com', null]);
    expect(accounts.map((a) => a.reader !== null)).toEqual([false, true, false]);
  });

  it('rejects an unknown region instead of sending the key to an unexpected host', async () => {
    await expect(loadPhoneInboxAccounts({ get: async (name: string) => (name === 'nylas_region' ? 'mars' : null) }))
      .rejects.toThrow(/nylas_region/);
  });

  it('has no readers at all without the Nylas key', async () => {
    const accounts = await loadPhoneInboxAccounts({ get: async (name: string) => (name.startsWith('phone_inbox_grant') ? 'g' : null) });
    expect(accounts.every((a) => a.reader === null)).toBe(true);
  });
});
