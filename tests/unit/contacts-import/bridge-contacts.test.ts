// bridge-contacts.test.ts — reading a bridge's contact list for the import. Made-up people only.

import { describe, it, expect, vi } from 'vitest';
import { fetchBridgeContacts, MAX_BRIDGE_CONTACTS } from '../../../src/contacts-import/bridge-contacts.js';
import { createSilentLogger } from '../../../src/logger.js';

const BRIDGE = { id: 'whatsapp', label: 'WhatsApp' };
const URL_ = 'http://mautrix-whatsapp.railway.internal:29318';

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const r = key ? routes[key]! : { status: 404, body: null };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}
const ok = (contacts: unknown[]) => fakeFetch({
  '/whoami': { status: 200, body: { logins: [{ id: 'login-1' }] } },
  '/contacts': { status: 200, body: { contacts } },
});

describe('fetchBridgeContacts', () => {
  it('turns bridge contacts into candidates with normalised numbers and stable source keys', async () => {
    const r = await fetchBridgeContacts(BRIDGE, URL_, 's', createSilentLogger(), ok([
      { id: 'c1', name: 'Dana Lee', identifiers: ['tel:+14165550100', 'mxid:@x:y'] },
      { id: 'c2', name: 'Bo', identifiers: ['tel:(416) 555-0101'] },
    ]));
    expect(r).toMatchObject({ ok: true, read: 2 });
    expect(r.candidates).toEqual([
      { sourceKey: 'bridge:whatsapp:c1', sourceId: 'bridge:whatsapp', displayName: 'Dana Lee', emails: [], phones: ['+14165550100'] },
      { sourceKey: 'bridge:whatsapp:c2', sourceId: 'bridge:whatsapp', displayName: 'Bo', emails: [], phones: ['+14165550101'] },
    ]);
  });

  it('skips entries with no usable number or no name instead of guessing', async () => {
    const r = await fetchBridgeContacts(BRIDGE, URL_, 's', createSilentLogger(), ok([
      { id: 'c1', name: 'No Number', identifiers: ['mxid:@x:y'] },
      { id: 'c2', identifiers: ['tel:+14165550100'] },
      { name: 'No Id', identifiers: ['tel:+14165550100'] },
      { id: 'c4', name: 'Short', identifiers: ['tel:12345'] },
      { id: 'c5', name: 'Fine', identifiers: ['tel:+14165550105'] },
    ]));
    expect(r.read).toBe(5);
    expect(r.candidates.map((c) => c.displayName)).toEqual(['Fine']);
  });

  it('sends the secret as a bearer token to the bridge only', async () => {
    const f = ok([]);
    await fetchBridgeContacts(BRIDGE, URL_, 'the-secret', createSilentLogger(), f);
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls.length).toBe(2);
    for (const [url, init] of calls) {
      expect(url.startsWith(URL_)).toBe(true);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer the-secret');
    }
  });

  it('reports a refused secret, a logged-out bridge and a bad answer in fixed words', async () => {
    const refused = await fetchBridgeContacts(BRIDGE, URL_, 's', createSilentLogger(), fakeFetch({ '/whoami': { status: 401, body: {} } }));
    expect(refused).toMatchObject({ ok: false, candidates: [] });
    expect(refused.message).toContain('refused the secret');

    const loggedOut = await fetchBridgeContacts(BRIDGE, URL_, 's', createSilentLogger(), fakeFetch({ '/whoami': { status: 200, body: { logins: [] } } }));
    expect(loggedOut.message).toContain('Nobody is logged in');

    const bad = await fetchBridgeContacts(BRIDGE, URL_, 's', createSilentLogger(), fakeFetch({
      '/whoami': { status: 200, body: { logins: [{ id: 'l' }] } }, '/contacts': { status: 500, body: {} },
    }));
    expect(bad).toMatchObject({ ok: false });
  });

  it('refuses an implausibly large list and never leaks the address or secret when the network fails', async () => {
    const huge = await fetchBridgeContacts(BRIDGE, URL_, 's', createSilentLogger(), ok(Array.from({ length: MAX_BRIDGE_CONTACTS + 1 }, (_, i) => ({ id: `c${i}`, name: 'X' }))));
    expect(huge.ok).toBe(false);

    const boom = vi.fn(async () => { throw new Error(`connect ECONNREFUSED ${URL_} secret=hunter2`); }) as unknown as typeof fetch;
    const r = await fetchBridgeContacts(BRIDGE, URL_, 'hunter2', createSilentLogger(), boom);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(JSON.stringify(r)).not.toContain('railway.internal');
  });
});
