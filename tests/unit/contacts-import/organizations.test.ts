import { describe, it, expect } from 'vitest';
import { mineOrganizations, orgNameFromDomain } from '../../../src/contacts-import/organizations.js';
import type { FarmFactRow } from '../../../src/contacts-import/farm-store.js';

const f = (accountId: string, email: string, over: Partial<FarmFactRow> = {}): FarmFactRow => ({
  accountId, email, domain: email.split('@')[1]!, displayName: null, received: 1, sent: 0, copied: 0,
  firstSeen: '2020-01-01T00:00:00.000Z', lastSeen: '2024-01-01T00:00:00.000Z', ...over,
});

describe('mineOrganizations', () => {
  it('groups people by domain, skipping webmail, role addresses and single-person domains', () => {
    const orgs = mineOrganizations([
      f('moonray', 'dana@acme.com', { received: 5, sent: 2 }),
      f('moonray', 'bob@acme.com', { lastSeen: '2025-05-05T00:00:00.000Z' }),
      f('moonray', 'info@acme.com'),
      f('personal', 'a@gmail.com'), f('personal', 'b@gmail.com'),
      f('moonray', 'solo@loner.org'),
    ], { moonray: 'WORK', personal: 'PERSONAL' });
    expect(orgs).toEqual([{ domain: 'acme.com', name: 'Acme', people: 2, received: 6, sent: 2, lastSeen: '2025-05-05T00:00:00.000Z', label: 'work', mailboxes: ['moonray'] }]);
  });
  it('counts a person once across mailboxes and calls an org hybrid when it spans work and personal mailboxes', () => {
    const [o] = mineOrganizations([f('moonray', 'dana@acme.com'), f('personal', 'dana@acme.com'), f('personal', 'bob@acme.com')], { moonray: 'WORK', personal: 'PERSONAL' });
    expect(o).toMatchObject({ people: 2, label: 'hybrid', mailboxes: ['moonray', 'personal'] });
  });
  it('has no label when no category is known, and ranks bigger organisations first', () => {
    const orgs = mineOrganizations([
      f('x', 'a@small.io'), f('x', 'b@small.io'),
      f('x', 'a@big.io'), f('x', 'b@big.io'), f('x', 'c@big.io'),
    ], {});
    expect(orgs.map((o) => [o.domain, o.label])).toEqual([['big.io', null], ['small.io', null]]);
  });
  it('derives a readable name from the domain', () => {
    expect(orgNameFromDomain('acme.com')).toBe('Acme');
    expect(orgNameFromDomain('mail.acme.com')).toBe('Acme');
    expect(orgNameFromDomain('acme.co.uk')).toBe('Acme');
  });
});
