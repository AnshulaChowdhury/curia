import { describe, it, expect } from 'vitest';
import { ContactsImportToken } from '../../../src/contacts-import/import-token.js';

function vault() {
  const m = new Map<string, string>();
  return { m, get: async (n: string) => m.get(n) ?? null, set: async (n: string, v: string) => void m.set(n, v) };
}

describe('ContactsImportToken', () => {
  it('is not configured until a token exists, and then verify returns null', async () => {
    const t = new ContactsImportToken(vault());
    expect(await t.isSet()).toBe(false);
    expect(await t.verify('anything')).toBeNull();
  });

  it('generates a token that verifies, stores only its hash, and replaces the old one', async () => {
    const v = vault();
    const t = new ContactsImportToken(v);
    const first = await t.generate();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect([...v.m.keys()]).toEqual(['contacts_import_token_hash']);
    expect([...v.m.values()].join()).not.toContain(first);
    expect(await t.verify(first)).toBe(true);
    expect(await t.verify('wrong')).toBe(false);
    const second = await t.generate();
    expect(await t.verify(first)).toBe(false);
    expect(await t.verify(second)).toBe(true);
    expect(await t.isSet()).toBe(true);
  });

  it('does not accept the books token (a different vault name)', async () => {
    const v = vault();
    v.m.set('books_api_token_hash', 'deadbeef');
    expect(await new ContactsImportToken(v).isSet()).toBe(false);
  });
});
