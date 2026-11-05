// unsubscribe.ts — what a newsletter's List-Unsubscribe header lets us do, and a safe way to do the one-click kind.
//
// The header and the address inside it are written by the sender, so they are untrusted. The only thing Curia does with
// them by itself is the RFC 8058 one-click request: an HTTPS POST of "List-Unsubscribe=One-Click" with no cookies, no
// login and no redirects. Before connecting, every address the host name resolves to is checked, at connect time, so
// a link cannot point Curia at its own network (localhost, private ranges, cloud metadata) even through DNS tricks.
// Anything else (a plain link, a mailto address) is handed back for the owner to open themselves.

import { request as httpsRequest, type RequestOptions } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';

export interface UnsubscribeOptions {
  /** Every https address in the header, in order. */
  links: string[];
  /** Every mailto address in the header, in order. */
  mailtos: string[];
  /** True when the sender says a POST to the https link unsubscribes (List-Unsubscribe-Post: List-Unsubscribe=One-Click). */
  oneClick: boolean;
}

const MAX_HEADER = 4_000;
const MAX_URL = 2_000;

/** Reads the `<...>, <...>` entries of a List-Unsubscribe header. Anything that is not https or mailto is dropped. */
export function parseListUnsubscribe(header: string | null | undefined, postHeader?: string | null): UnsubscribeOptions {
  const out: UnsubscribeOptions = { links: [], mailtos: [], oneClick: /list-unsubscribe\s*=\s*one-click/i.test(postHeader ?? '') };
  if (!header) return out;
  for (const match of header.slice(0, MAX_HEADER).matchAll(/<([^<>]{1,2000})>/g)) {
    const entry = (match[1] ?? '').trim();
    if (/^mailto:/i.test(entry)) out.mailtos.push(entry.slice(0, MAX_URL));
    else if (/^https:\/\//i.test(entry) && entry.length <= MAX_URL) out.links.push(entry);
  }
  return out;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True for an address on the public internet. IPv4-mapped IPv6 addresses are judged as their IPv4 address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** The URL if Curia may POST to it: https, the standard port, no embedded login, a name (not a bare IP address). */
export function oneClickTarget(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) return null;
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return null;
  if (url.hostname === 'localhost' || !url.hostname.includes('.')) return null;
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type LookupFn = (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCallback) => void;

/** A DNS lookup for https.request that refuses to hand back any address that is not public. */
export function publicOnlyLookup(inner: (host: string, opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => void = dnsLookup as never): LookupFn {
  return (hostname, options, cb) => {
    inner(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, []);
      if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
        return cb(Object.assign(new Error('address not allowed'), { code: 'EBLOCKED' }) as NodeJS.ErrnoException, []);
      }
      if (options.all) return cb(null, addresses);
      const first = addresses[0];
      return first ? cb(null, first.address, first.family) : cb(new Error('no address') as NodeJS.ErrnoException, []);
    });
  };
}

export type OneClickResult = { ok: true; status: number } | { ok: false; status?: number };

export interface OneClickDeps {
  request?: (url: URL, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;
  lookup?: LookupFn;
  timeoutMs?: number;
}

/** POSTs the one-click body. 2xx = unsubscribed. Redirects are not followed; errors say nothing about the URL. */
export function postOneClick(url: URL, deps: OneClickDeps = {}): Promise<OneClickResult> {
  const { request = httpsRequest as OneClickDeps['request'], lookup = publicOnlyLookup(), timeoutMs = 10_000 } = deps;
  const body = 'List-Unsubscribe=One-Click';
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: OneClickResult) => { if (!settled) { settled = true; resolve(result); } };
    const req = request!(url, {
      method: 'POST',
      lookup: lookup as RequestOptions['lookup'],
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)), 'User-Agent': 'Curia-Unsubscribe/1.0' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      res.destroy(); // the answer's text is never read
      done(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false }); });
    req.on('error', () => done({ ok: false }));
    req.end(body);
  });
}
