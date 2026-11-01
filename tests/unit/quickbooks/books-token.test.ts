import { describe, it, expect } from 'vitest';
import { BooksToken } from '../../../src/quickbooks/books-token.js';

function vault() {
  const m = new Map<string, string>();
  return { m, get: async (n: string) => m.get(n) ?? null, set: async (n: string, v: string) => void m.set(n, v) };
}

describe('BooksToken', () => {
  it('is not configured until a token exists, and then verify returns null', async () => {
    const t = new BooksToken(vault(), () => null);
    expect(await t.isSet()).toBe(false);
    expect(await t.verify('anything')).toBeNull();
  });

  it('generates a token that verifies, stores only its hash, and replaces the old one', async () => {
    const v = vault();
    const t = new BooksToken(v, () => null);
    const first = await t.generate();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect([...v.m.values()].join()).not.toContain(first);
    expect(await t.verify(first)).toBe(true);
    expect(await t.verify('wrong')).toBe(false);
    const second = await t.generate();
    expect(await t.verify(first)).toBe(false);
    expect(await t.verify(second)).toBe(true);
    expect(await t.isSet()).toBe(true);
  });

  it('falls back to BOOKS_API_TOKEN until a token is generated, which then replaces it', async () => {
    const t = new BooksToken(vault(), () => 'env-token');
    expect(await t.isSet()).toBe(true);
    expect(await t.verify('env-token')).toBe(true);
    const made = await t.generate();
    expect(await t.verify('env-token')).toBe(false);
    expect(await t.verify(made)).toBe(true);
  });
});
