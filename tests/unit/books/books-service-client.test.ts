import { describe, it, expect, vi } from 'vitest';
import { BooksServiceClient, BooksServiceError, booksServiceFromEnv } from '../../../src/books/books-service-client.js';
import type { Logger } from '../../../src/logger.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
const client = (fetchFn: typeof fetch) => new BooksServiceClient('http://books.internal:8080', 'tok', logger, fetchFn);

describe('BooksServiceClient', () => {
  it('posts the run with the bearer token and returns the answer', async () => {
    const fetchFn = vi.fn(async () => json(200, { rules_version: 'v', need_qbo: { start: '2026-01-01', end: '2026-02-01' } }));
    const out = await client(fetchFn as unknown as typeof fetch).run({ files: [], state: null });
    expect(out).toMatchObject({ need_qbo: { start: '2026-01-01' } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/v1/run');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('maps failures to typed errors', async () => {
    const kind = async (fetchFn: () => Promise<Response>): Promise<string> => {
      try {
        await client(fetchFn as unknown as typeof fetch).accounts();
      } catch (err) {
        return (err as BooksServiceError).kind;
      }
      return 'none';
    };
    expect(await kind(async () => { throw new Error('ECONNREFUSED'); })).toBe('unreachable');
    expect(await kind(async () => json(401, {}))).toBe('unauthorised');
    expect(await kind(async () => json(400, { error: 'bad file' }))).toBe('rejected');
    expect(await kind(async () => json(500, {}))).toBe('failed');
    expect(await kind(async () => new Response('<html>', { status: 200 }))).toBe('failed');
    expect(await kind(async () => json(200, { nope: 1 }))).toBe('failed');
  });

  it('is only built when both settings exist', () => {
    expect(booksServiceFromEnv({}, logger)).toBeNull();
    expect(booksServiceFromEnv({ BOOKS_SERVICE_URL: 'http://x' }, logger)).toBeNull();
    expect(booksServiceFromEnv({ BOOKS_SERVICE_URL: 'http://x', BOOKS_SERVICE_TOKEN: 't' }, logger)).not.toBeNull();
  });
});
