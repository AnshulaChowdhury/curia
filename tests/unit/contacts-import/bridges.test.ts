// bridges.test.ts — address rules and the read-only bridge check. Uses made-up people and numbers only.

import { describe, it, expect, vi } from 'vitest';
import { bridgeUrlProblem, isPrivateBridgeHost, testBridge, bridgeVaultKeys, findBridge, BRIDGES } from '../../../src/contacts-import/bridges.js';
import { createSilentLogger } from '../../../src/logger.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('isPrivateBridgeHost / bridgeUrlProblem', () => {
  it.each([
    'mautrix-signal.railway.internal', 'localhost', '127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.255.1', '192.168.1.9', '[::1]',
  ])('allows %s', host => expect(isPrivateBridgeHost(host)).toBe(true));

  it.each([
    'example.com', 'mautrix-signal.up.railway.app', '8.8.8.8', '172.32.0.1', '11.0.0.1', '300.1.1.1', 'railway.internal.evil.com',
  ])('refuses %s', host => expect(isPrivateBridgeHost(host)).toBe(false));

  it('accepts a private address and refuses anything that could leak the secret', () => {
    expect(bridgeUrlProblem('http://mautrix-signal.railway.internal:29328')).toBeNull();
    expect(bridgeUrlProblem('https://bridge.example.com')).toMatch(/private network/);
    expect(bridgeUrlProblem('http://user:pw@mautrix-signal.railway.internal:29328')).toMatch(/username/);
    expect(bridgeUrlProblem('http://mautrix-signal.railway.internal:29328/?x=1')).toMatch(/query/);
    expect(bridgeUrlProblem('ftp://mautrix-signal.railway.internal')).toMatch(/http/);
    expect(bridgeUrlProblem('not a url')).toMatch(/valid URL/);
  });
});

describe('vault names', () => {
  it('are derived from the fixed bridge table only', () => {
    expect(BRIDGES.map(b => b.id)).toEqual(['whatsapp', 'gmessages', 'signal', 'instagram']);
    expect(bridgeVaultKeys('signal')).toEqual({ url: 'matrix_bridge_signal_url', secret: 'matrix_bridge_signal_secret' });
    expect(findBridge('bogus')).toBeUndefined();
    expect(findBridge('../etc')).toBeUndefined();
  });
});

describe('testBridge', () => {
  const logger = createSilentLogger();
  const URL_ = 'http://mautrix-signal.railway.internal:29328/';

  it('counts contacts and phone numbers, and returns no names, numbers or ids', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      calls.push(u);
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer s3cret');
      if (u.includes('/whoami')) return json(200, { network: { network_id: 'signal' }, logins: [{ id: 'login-abc', state_event: 'CONNECTED' }] });
      return json(200, { contacts: [
        { id: 'a', name: 'Test Person One', mxid: '@signal_a:mautrix', identifiers: ['tel:+15550100'] },
        { id: 'b', name: 'Test Person Two', mxid: '@signal_b:mautrix', identifiers: ['tel:+15550101', 'tel:+15550102'] },
        { id: 'c', name: 'Handle Only', mxid: '@signal_c:mautrix', identifiers: ['signal:handle'] },
      ] });
    }) as unknown as typeof fetch;

    const r = await testBridge(URL_, 's3cret', logger, fetchImpl);
    expect(r).toEqual({ ok: true, message: 'Connected.', network: 'signal', loginState: 'CONNECTED', contacts: 3, withPhone: 2 });
    const text = JSON.stringify(r);
    for (const leak of ['Test Person', '5550100', 'login-abc', 's3cret', '@signal_']) expect(text).not.toContain(leak);
    expect(calls[0]).toBe('http://mautrix-signal.railway.internal:29328/_matrix/provision/v3/whoami?user_id=%40anshula%3Amautrix');
    expect(calls[1]).toContain('/_matrix/provision/v3/contacts?login_id=login-abc&user_id=');
  });

  it('says so when nobody is logged in (Instagram today), without calling the contact list', async () => {
    const fetchImpl = vi.fn(async () => json(200, { network: { network_id: 'instagram' }, logins: [] })) as unknown as typeof fetch;
    const r = await testBridge(URL_, 's', logger, fetchImpl);
    expect(r).toMatchObject({ ok: false, network: 'instagram', loginState: 'none' });
    expect(r.message).toMatch(/nobody is logged in/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a refused secret, a 404, and an unexpected body with fixed text', async () => {
    const mk = (status: number, body: unknown) => vi.fn(async () => json(status, body)) as unknown as typeof fetch;
    expect((await testBridge(URL_, 'bad', logger, mk(401, { error: 'echoed-secret-bad' }))).message).toBe('The bridge refused the secret (HTTP 401).');
    expect((await testBridge(URL_, 's', logger, mk(500, { error: 'boom' }))).message).toBe('The bridge answered HTTP 500 to whoami.');

    const noList = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/whoami') ? json(200, { logins: [{ id: 'x', state_event: 'CONNECTED' }] }) : json(404, { err: 'nope' })) as unknown as typeof fetch;
    expect((await testBridge(URL_, 's', logger, noList)).message).toBe('The bridge answered HTTP 404 to the contact list.');

    const wrongShape = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/whoami') ? json(200, { logins: [{ id: 'x' }] }) : json(200, { something: 1 })) as unknown as typeof fetch;
    expect((await testBridge(URL_, 's', logger, wrongShape)).message).toBe('The bridge answered, but not with a contact list.');
  });

  it('does not echo the address or the error when the bridge cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed: http://mautrix-signal.railway.internal:29328 s3cret'); }) as unknown as typeof fetch;
    const r = await testBridge(URL_, 's3cret', logger, fetchImpl);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('s3cret');
    expect(JSON.stringify(r)).not.toContain('railway.internal');
  });
});
