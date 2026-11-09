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
    const { store, query } = pool([{ scope: 'domain', group_name: 'newsletter', keywords: [] }, { scope: 'sender', group_name: 'drafted', keywords: [] }]);
    expect(await store.lookup('moonray', 'Dana@Acme.com')).toBe('drafted');
    expect(args(query)[1]).toEqual(['moonray', 'dana@acme.com', 'acme.com']);
  });

  it('falls back to the domain, and is null with no match, no address or an unknown stored group', async () => {
    expect(await pool([{ scope: 'domain', group_name: 'seen', keywords: [] }]).store.lookup('moonray', 'x@acme.com')).toBe('seen');
    expect(await pool([]).store.lookup('moonray', 'x@acme.com')).toBeNull();
    const none = pool([]);
    expect(await none.store.lookup('moonray', 'not an address')).toBeNull();
    expect(none.query).not.toHaveBeenCalled();
    expect(await pool([{ scope: 'sender', group_name: 'bogus', keywords: [] }]).store.lookup('moonray', 'x@acme.com')).toBeNull();
  });

  it('upserts, lists (skipping unknown groups) and removes', async () => {
    const saved = pool();
    await saved.store.save({ accountId: 'moonray', scope: 'sender', value: 'a@acme.com', group: 'spam' });
    expect(args(saved.query)[0]).toMatch(/ON CONFLICT \(account_id, scope, value, keywords\) DO UPDATE/);
    expect(args(saved.query)[1]).toEqual(['moonray', 'sender', 'a@acme.com', 'spam', []]);

    const listed = pool([
      { account_id: 'moonray', scope: 'sender', value: 'a@acme.com', group_name: 'spam', keywords: [] },
      { account_id: 'moonray', scope: 'domain', value: 'b.com', group_name: 'bogus', keywords: [] },
    ]);
    expect(await listed.store.list()).toEqual([{ accountId: 'moonray', scope: 'sender', value: 'a@acme.com', group: 'spam', keywords: [] }]);

    expect(await pool([], 1).store.remove('moonray', 'sender', 'a@acme.com')).toBe(true);
    expect(await pool([], 0).store.remove('moonray', 'sender', 'a@acme.com')).toBe(false);
  });

  describe('keyword rules', () => {
    const rules = [
      { account_id: 'moonray', scope: 'sender-keywords', value: 'billing@acme.com', group_name: 'urgent', keywords: ['invoice', 'overdue'] },
      { account_id: 'moonray', scope: 'sender-keywords', value: 'billing@acme.com', group_name: 'newsletter', keywords: ['digest'] },
      { account_id: 'moonray', scope: 'sender', value: 'billing@acme.com', group_name: 'seen', keywords: [] },
    ];
    const ctx = (subject: string, preview = '') => ({ subject, preview });

    it('a matching keyword rule beats the plain sender rule', async () => {
      expect(await pool(rules).store.lookup('moonray', 'billing@acme.com', ctx('Invoice 12', 'payment is overdue'))).toBe('urgent');
      expect(await pool(rules).store.lookup('moonray', 'billing@acme.com', ctx('Your weekly digest'))).toBe('newsletter');
    });

    it('falls back to the sender rule when no keywords match, or when the email text is not given', async () => {
      expect(await pool(rules).store.lookup('moonray', 'billing@acme.com', ctx('Lunch?'))).toBe('seen');
      expect(await pool(rules).store.lookup('moonray', 'billing@acme.com')).toBe('seen');
    });

    it('saves and removes a rule by its sender and its words', async () => {
      const saved = pool();
      await saved.store.save({ accountId: 'moonray', scope: 'sender-keywords', value: 'billing@acme.com', group: 'urgent', keywords: ['invoice', 'overdue'] });
      expect(args(saved.query)[1]).toEqual(['moonray', 'sender-keywords', 'billing@acme.com', 'urgent', ['invoice', 'overdue']]);
      const removed = pool();
      await removed.store.remove('moonray', 'sender-keywords', 'billing@acme.com', ['invoice', 'overdue']);
      expect(args(removed.query)[0]).toMatch(/keywords = \$4/);
      expect(args(removed.query)[1]).toEqual(['moonray', 'sender-keywords', 'billing@acme.com', ['invoice', 'overdue']]);
    });

    it('ignores keywords on the other scopes', async () => {
      const saved = pool();
      await saved.store.save({ accountId: 'moonray', scope: 'sender', value: 'a@acme.com', group: 'spam', keywords: ['sneaky'] });
      expect(args(saved.query)[1][4]).toEqual([]);
    });
  });
});
