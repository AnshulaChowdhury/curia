import { describe, expect, it, vi } from 'vitest';
import { PgPreferenceStore, addressParts, isSharedMailDomain, validPreferenceValue } from '../../../src/inbox-triage/preference-store.js';
import type { DbPool } from '../../../src/db/connection.js';

const pool = (rows: unknown[] = [], rowCount = 1) => {
  const query = vi.fn(async (..._a: unknown[]) => ({ rows, rowCount }));
  return { store: new PgPreferenceStore({ query } as unknown as DbPool), query };
};
const args = (q: ReturnType<typeof vi.fn>, n = 0) => q.mock.calls[n] as unknown as [string, unknown[]];

describe('addressParts', () => {
  it('lower-cases a plain address and finds its domain', () => {
    expect(addressParts(' Dana@Acme.COM ')).toEqual({ address: 'dana@acme.com', domain: 'acme.com' });
  });
  it.each(['', 'dana', 'dana@', '@acme.com', 'dana@localhost', 'Dana <dana@acme.com>', 'a b@acme.com', 'a@b@acme.com'])('rejects %j', (raw) => {
    expect(addressParts(raw)).toBeNull();
  });
});

describe('validPreferenceValue', () => {
  it('needs an exact lower-case address for sender and a non-shared domain for domain', () => {
    expect(validPreferenceValue('sender', 'dana@acme.com')).toBe(true);
    expect(validPreferenceValue('sender', 'Dana@acme.com')).toBe(false);
    expect(validPreferenceValue('sender', 'acme.com')).toBe(false);
    expect(validPreferenceValue('domain', 'acme.com')).toBe(true);
    expect(validPreferenceValue('domain', 'gmail.com')).toBe(false);
    expect(validPreferenceValue('domain', 'dana@acme.com')).toBe(false);
    expect(isSharedMailDomain('Outlook.com')).toBe(true);
  });
});

describe('PgPreferenceStore', () => {
  it('prefers the exact sender over its domain', async () => {
    const { store, query } = pool([{ scope: 'domain', group_name: 'newsletter' }, { scope: 'sender', group_name: 'drafted' }]);
    expect(await store.lookup('moonray', 'Dana@Acme.com')).toBe('drafted');
    expect(args(query)[1]).toEqual(['moonray', 'dana@acme.com', 'acme.com']);
  });

  it('falls back to the domain, and is null with no match, no address or an unknown stored group', async () => {
    expect(await pool([{ scope: 'domain', group_name: 'seen' }]).store.lookup('moonray', 'x@acme.com')).toBe('seen');
    expect(await pool([]).store.lookup('moonray', 'x@acme.com')).toBeNull();
    const none = pool([]);
    expect(await none.store.lookup('moonray', 'not an address')).toBeNull();
    expect(none.query).not.toHaveBeenCalled();
    expect(await pool([{ scope: 'sender', group_name: 'bogus' }]).store.lookup('moonray', 'x@acme.com')).toBeNull();
  });

  it('upserts, lists (skipping unknown groups) and removes', async () => {
    const saved = pool();
    await saved.store.save({ accountId: 'moonray', scope: 'sender', value: 'a@acme.com', group: 'spam' });
    expect(args(saved.query)[0]).toMatch(/ON CONFLICT \(account_id, scope, value\) DO UPDATE/);
    expect(args(saved.query)[1]).toEqual(['moonray', 'sender', 'a@acme.com', 'spam']);

    const listed = pool([
      { account_id: 'moonray', scope: 'sender', value: 'a@acme.com', group_name: 'spam' },
      { account_id: 'moonray', scope: 'domain', value: 'b.com', group_name: 'bogus' },
    ]);
    expect(await listed.store.list()).toEqual([{ accountId: 'moonray', scope: 'sender', value: 'a@acme.com', group: 'spam' }]);

    expect(await pool([], 1).store.remove('moonray', 'sender', 'a@acme.com')).toBe(true);
    expect(await pool([], 0).store.remove('moonray', 'sender', 'a@acme.com')).toBe(false);
  });
});
