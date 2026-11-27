// security-headers.test.ts — verifies the baseline security response headers are set
// on every HTTP response, including non-2xx ones. Mirrors the bare-Fastify + inject
// harness used by the route tests.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  registerSecurityHeaders,
  CONSOLE_CONTENT_SECURITY_POLICY,
  ANTFARM_CONTENT_SECURITY_POLICY,
  PLAID_LINK_CONTENT_SECURITY_POLICY,
  SHEET_CONTENT_SECURITY_POLICY,
  CONVERTER_CONTENT_SECURITY_POLICY,
  CHAT_CONTENT_SECURITY_POLICY,
  UNIVER_STYLE_HASHES,
} from '../../../../src/channels/http/security-headers.js';
import { readFileSync } from 'node:fs';

let app: FastifyInstance | undefined;

afterEach(async () => {
  try {
    await app?.close();
  } catch (err) {
    // Surface a teardown failure in the test report rather than letting it become an
    // unhandled rejection between tests.
    throw new Error(`test teardown: app.close() failed: ${(err as Error).message}`, { cause: err });
  } finally {
    app = undefined;
  }
});

async function build(): Promise<FastifyInstance> {
  const instance = Fastify();
  // Register headers BEFORE routes/other hooks so the header is set even when a later
  // onRequest hook short-circuits the response (e.g. an auth 401).
  registerSecurityHeaders(instance);
  for (const url of ['/budget/sheet-frame', '/budget/sheet-frame-evil', '/budget/sheet-frame/x', '/budget/convert-frame', '/convert-frame.html']) {
    instance.get(url, async (_req, reply) => reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>s</body></html>'));
  }
  for (const url of ['/chat', '/chat/', '/chat-evil', '/chat/x']) {
    instance.get(url, async (_req, reply) => reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>c</body></html>'));
  }
  instance.get('/assets/a.js', async (_req, reply) => reply.type('text/javascript').send('1'));
  // The budget pages: only /budget/connect-bank may load Plaid Link.
  for (const url of ['/budget', '/budget/connect-bank', '/budget/connect-bank/', '/budget/connect-bank-evil', '/budget/connect-bank/x', '/budget-extra']) {
    instance.get(url, async (_req, reply) => reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>b</body></html>'));
  }
  instance.get('/ok', async () => ({ ok: true }));
  instance.get('/html', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>ok</body></html>');
  });
  // Ant Farm SPA routes (served as HTML) — deep links resolve to the same index.html.
  instance.get('/antfarm/', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>antfarm</body></html>');
  });
  instance.get('/antfarm/deep/link', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>antfarm</body></html>');
  });
  // Bare /antfarm (no trailing slash) is NOT served by the antfarm bundle in prod — it
  // falls through to the console wildcard and returns console HTML. Model that here so the
  // test proves it keeps the strict console CSP, not the relaxed antfarm one.
  instance.get('/antfarm', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html><body>console</body></html>');
  });
  // A hook that 401s before the handler — proves the header lands on short-circuited
  // responses (the case that matters for the API's auth gate).
  instance.get('/blocked', {
    onRequest: async (_req, reply) => reply.status(401).send({ error: 'no' }),
  }, async () => ({ never: true }));
  try {
    await instance.ready();
  } catch (err) {
    // Close the half-initialized instance before propagating so a failed ready() never
    // leaks an open server, and normalize the error with context.
    await instance.close().catch(() => {});
    throw new Error(`test Fastify instance failed to start: ${(err as Error).message}`, { cause: err });
  }
  return instance;
}

// Mirrors http-adapter.ts: register cors + rate-limit FIRST, then the security headers.
// Both plugins terminate requests in their own onRequest hooks (preflight OPTIONS, 429),
// so this proves the onSend-based header survives a plugin short-circuit that a later
// onRequest hook would miss.
async function buildWithPlugins(): Promise<FastifyInstance> {
  const instance = Fastify();
  try {
    await instance.register(rateLimit, { max: 1, timeWindow: '1 minute' });
    await instance.register(cors, { origin: 'https://example.com', credentials: true });
    registerSecurityHeaders(instance);
    instance.get('/ok', async () => ({ ok: true }));
    await instance.ready();
  } catch (err) {
    await instance.close().catch(() => {});
    throw new Error(`test Fastify instance failed to start: ${(err as Error).message}`, { cause: err });
  }
  return instance;
}

describe('registerSecurityHeaders', () => {
  it('sets X-Content-Type-Options: nosniff on a 200 response', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a 404 response', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a response short-circuited by a later onRequest hook (401)', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/blocked' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a 429 short-circuited by @fastify/rate-limit', async () => {
    app = await buildWithPlugins();
    const first = await app.inject({ method: 'GET', url: '/ok' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    const second = await app.inject({ method: 'GET', url: '/ok' });
    expect(second.statusCode).toBe(429);
    expect(second.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets the header on a CORS preflight (OPTIONS) handled by @fastify/cors', async () => {
    app = await buildWithPlugins();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/ok',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'GET' },
    });
    // @fastify/cors replies to the preflight directly (204 No Content).
    expect([200, 204]).toContain(res.statusCode);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not set Content-Security-Policy on JSON responses', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('sets Content-Security-Policy and X-Frame-Options on HTML responses', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('locks script-src to self in the console CSP', async () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('cdn.tailwindcss.com');
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });

  it('does not allow data: images in the strict console CSP', async () => {
    // Regression guard: the console must not inherit the Ant Farm relaxation.
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain("img-src 'self'");
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('data:');
  });

  it('serves the Ant Farm CSP (img-src data: blob:) on /antfarm/ HTML responses', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/antfarm/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(ANTFARM_CONTENT_SECURITY_POLICY);
    // Both schemes are required: data: for Phaser's base64 boot textures, blob: for the
    // loader-fetched licensed art (XHR → URL.createObjectURL). Missing blob: silently
    // degrades the office to placeholders even though the assets serve fine.
    expect(res.headers['content-security-policy']).toContain("img-src 'self' data: blob:");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('serves the Ant Farm CSP on deep-linked /antfarm/* HTML (SPA fallback)', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/antfarm/deep/link?t=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(ANTFARM_CONTENT_SECURITY_POLICY);
  });

  it('keeps the strict console CSP on non-Ant-Farm HTML', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
  });

  it('keeps the strict console CSP on bare /antfarm (served by the console wildcard)', async () => {
    // Regression guard: bare /antfarm (no trailing slash) resolves to console HTML in prod,
    // so it must NOT receive the relaxed img-src data: policy.
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/antfarm' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
    expect(res.headers['content-security-policy']).not.toContain('data:');
  });

  it('keeps script-src strict in the Ant Farm CSP (only images are relaxed)', async () => {
    expect(ANTFARM_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(ANTFARM_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(ANTFARM_CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: blob:");
  });

  it('serves the Plaid Link CSP on exactly /budget/connect-bank (with or without a slash or query)', async () => {
    app = await build();
    for (const url of ['/budget/connect-bank', '/budget/connect-bank/', '/budget/connect-bank?x=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toBe(PLAID_LINK_CONTENT_SECURITY_POLICY);
    }
  });

  it('keeps the strict console CSP on every other budget path, including look-alikes', async () => {
    app = await build();
    for (const url of ['/budget', '/budget/connect-bank-evil', '/budget/connect-bank/x', '/budget-extra']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
      expect(res.headers['content-security-policy'], url).not.toContain('plaid');
    }
  });

  it('opens only Plaid origins on the Plaid page: no inline script, no wildcard source, no other host', () => {
    expect(PLAID_LINK_CONTENT_SECURITY_POLICY).toContain("script-src 'self' https://cdn.plaid.com;");
    expect(PLAID_LINK_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(PLAID_LINK_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    const scriptSrc = PLAID_LINK_CONTENT_SECURITY_POLICY.split('; ').find(d => d.startsWith('script-src'))!;
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(PLAID_LINK_CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    const hosts = PLAID_LINK_CONTENT_SECURITY_POLICY.match(/https:\/\/[^\s;]+/g)!.filter(h => !/plaid\.com$/.test(h) && !/fonts\.g/.test(h));
    expect(hosts).toEqual([]);
  });
});

describe('spreadsheet pages', () => {
  const headersFor = async (url: string, headers: Record<string, string> = {}) => {
    app = await build();
    const res = await app.inject({ method: 'GET', url, headers });
    await app.close(); app = undefined;
    return res.headers;
  };
  const directive = (policy: string, name: string) => policy.split('; ').find(d => d.startsWith(`${name} `)) ?? '';

  it('loosens only the exact sheet page, which Curia alone may frame', async () => {
    for (const url of ['/budget/sheet-frame', '/budget/sheet-frame?id=1']) {
      const h = await headersFor(url);
      expect(h['content-security-policy'], url).toBe(SHEET_CONTENT_SECURITY_POLICY);
      expect(h['x-frame-options']).toBe('SAMEORIGIN');
    }
    for (const url of ['/budget', '/budget/sheet-frame-evil', '/budget/sheet-frame/x']) {
      const h = await headersFor(url);
      expect(h['content-security-policy'], url).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
      expect(h['x-frame-options']).toBe('DENY');
    }
  });

  it('lets only the exact chat page frame Curia\'s own pages, and loosens nothing else there', async () => {
    for (const url of ['/chat', '/chat/', '/chat?attach=1']) {
      const h = await headersFor(url);
      expect(h['content-security-policy'], url).toBe(CHAT_CONTENT_SECURITY_POLICY);
      expect(h['x-frame-options']).toBe('DENY');
    }
    for (const url of ['/chat-evil', '/chat/x']) {
      expect((await headersFor(url))['content-security-policy'], url).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
    }
    expect(CHAT_CONTENT_SECURITY_POLICY.split('; ')).toEqual([...CONSOLE_CONTENT_SECURITY_POLICY.split('; '), "frame-src 'self'"]);
  });

  it('allows the grid three exact stylesheets and inline images, never inline or evaluated script', () => {
    expect(directive(SHEET_CONTENT_SECURITY_POLICY, 'script-src')).toBe("script-src 'self'");
    expect(SHEET_CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    const styles = directive(SHEET_CONTENT_SECURITY_POLICY, 'style-src-elem');
    expect(styles).not.toContain('unsafe-inline');
    for (const hash of UNIVER_STYLE_HASHES) expect(styles).toContain(hash);
    expect(directive(SHEET_CONTENT_SECURITY_POLICY, 'img-src')).toBe("img-src 'self' data:");
  });

  it('shuts the converter in: sandboxed without an origin, no network, own scripts only', async () => {
    for (const url of ['/budget/convert-frame', '/convert-frame.html']) {
      expect((await headersFor(url))['content-security-policy'], url).toBe(CONVERTER_CONTENT_SECURITY_POLICY);
    }
    expect(CONVERTER_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(CONVERTER_CONTENT_SECURITY_POLICY).toContain('sandbox allow-scripts');
    expect(CONVERTER_CONTENT_SECURITY_POLICY).not.toContain('allow-same-origin');
    expect(directive(CONVERTER_CONTENT_SECURITY_POLICY, 'script-src')).toBe("script-src 'self'");
  });

  it('lets the originless frame load public assets, without credentials, and nothing else', async () => {
    expect((await headersFor('/assets/a.js', { origin: 'null' }))['access-control-allow-origin']).toBe('*');
    expect((await headersFor('/assets/a.js', { origin: 'null' }))['access-control-allow-credentials']).toBeUndefined();
    expect((await headersFor('/assets/a.js'))['access-control-allow-origin']).toBeUndefined();
    expect((await headersFor('/ok', { origin: 'null' }))['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps the grid library pinned to the version whose styles are allowed', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../../apps/console/package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    // Changing these changes the injected stylesheets: recompute UNIVER_STYLE_HASHES, then update this test.
    expect(pkg.dependencies['@univerjs/presets']).toBe('1.5.2');
    expect(pkg.dependencies['@univerjs/preset-sheets-core']).toBe('1.5.2');
    expect(pkg.dependencies['@zwight/luckyexcel']).toBe('1.1.6');
  });
});
