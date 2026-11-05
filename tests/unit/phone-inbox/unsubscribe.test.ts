import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  isPublicAddress, oneClickTarget, parseListUnsubscribe, postOneClick, publicOnlyLookup,
} from '../../../src/phone-inbox/unsubscribe.js';

describe('parseListUnsubscribe', () => {
  it('reads https and mailto entries and the one-click marker', () => {
    expect(parseListUnsubscribe('<mailto:u@x.com?subject=unsub>, <https://x.com/u?t=1>', 'List-Unsubscribe=One-Click')).toEqual({
      links: ['https://x.com/u?t=1'], mailtos: ['mailto:u@x.com?subject=unsub'], oneClick: true,
    });
  });
  it('drops anything else (http, javascript:, file:) and is empty without a header', () => {
    expect(parseListUnsubscribe('<http://x.com/u>, <javascript:alert(1)>, <file:///etc/passwd>')).toEqual({ links: [], mailtos: [], oneClick: false });
    expect(parseListUnsubscribe(null)).toEqual({ links: [], mailtos: [], oneClick: false });
  });
  it('is not one-click without the Post header', () => {
    expect(parseListUnsubscribe('<https://x.com/u>', null).oneClick).toBe(false);
  });
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('allows %s', (a) => expect(isPublicAddress(a)).toBe(true));
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip',
  ])('blocks %s', (a) => expect(isPublicAddress(a)).toBe(false));
});

describe('oneClickTarget', () => {
  it('accepts an https link on a named host', () => {
    expect(oneClickTarget('https://news.example.com/unsub?id=1')?.hostname).toBe('news.example.com');
    expect(oneClickTarget('https://news.example.com:443/u')).not.toBeNull();
  });
  it.each([
    'http://news.example.com/u', 'https://user:pw@news.example.com/u', 'https://news.example.com:8443/u', 'https://127.0.0.1/u',
    'https://[::1]/u', 'https://169.254.169.254/latest', 'https://localhost/u', 'https://intranet/u', 'ftp://x.com/u', 'not a url',
  ])('refuses %s', (raw) => expect(oneClickTarget(raw)).toBeNull());
});

describe('publicOnlyLookup', () => {
  const lookupOf = (...addresses: string[]) => (_h: string, _o: { all: true }, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
    cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('returns public addresses in the shape the caller asked for', () => {
    const cb = vi.fn();
    publicOnlyLookup(lookupOf('93.184.216.34') as never)('x.com', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    const single = vi.fn();
    publicOnlyLookup(lookupOf('93.184.216.34') as never)('x.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('refuses when any resolved address is private (a name that points inside), or none resolve', () => {
    for (const set of [['10.0.0.5'], ['93.184.216.34', '127.0.0.1'], []]) {
      const cb = vi.fn();
      publicOnlyLookup(lookupOf(...set) as never)('evil.example', { all: true }, cb);
      expect(cb.mock.calls[0]![0]).toMatchObject({ code: expect.any(String) });
    }
  });
});

function fakeRequest(outcome: { status?: number; error?: boolean; hang?: boolean }) {
  const written: string[] = [];
  const calls: Array<{ url: URL; options: Record<string, unknown> }> = [];
  const request = ((url: URL, options: Record<string, unknown>, onResponse: (r: unknown) => void) => {
    calls.push({ url, options });
    const req = new EventEmitter() as EventEmitter & { end: (b: string) => void; destroy: () => void };
    req.destroy = vi.fn();
    req.end = (b: string) => {
      written.push(b);
      if (outcome.error) queueMicrotask(() => req.emit('error', new Error('boom')));
      else if (outcome.hang) queueMicrotask(() => req.emit('timeout'));
      else queueMicrotask(() => onResponse({ statusCode: outcome.status, destroy: vi.fn() }));
    };
    return req;
  }) as never;
  return { request, written, calls };
}

describe('postOneClick', () => {
  const url = new URL('https://news.example.com/unsub?id=1');

  it('POSTs the one-click body, with the guarded lookup and no auth or cookies', async () => {
    const f = fakeRequest({ status: 200 });
    expect(await postOneClick(url, { request: f.request })).toEqual({ ok: true, status: 200 });
    expect(f.written).toEqual(['List-Unsubscribe=One-Click']);
    const { options } = f.calls[0]!;
    expect(options).toMatchObject({ method: 'POST', lookup: expect.any(Function) });
    expect(Object.keys(options.headers as object).map((h) => h.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(options.headers as object).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('does not follow redirects: a 3xx or an error status is a failure', async () => {
    expect(await postOneClick(url, { request: fakeRequest({ status: 302 }).request })).toEqual({ ok: false, status: 302 });
    expect(await postOneClick(url, { request: fakeRequest({ status: 500 }).request })).toEqual({ ok: false, status: 500 });
  });

  it('reports a network error or a timeout as a failure', async () => {
    expect(await postOneClick(url, { request: fakeRequest({ error: true }).request })).toEqual({ ok: false });
    expect(await postOneClick(url, { request: fakeRequest({ hang: true }).request })).toEqual({ ok: false });
  });
});
