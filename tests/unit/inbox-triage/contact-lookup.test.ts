import { describe, expect, it, vi } from 'vitest';
import { contactLookupFor, type ContactResolver } from '../../../src/inbox-triage/contact-lookup.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const resolverOf = (found: { tier: string; kind: string } | null): ContactResolver => ({ resolveByChannelIdentity: vi.fn(async () => found) });

describe('contactLookupFor', () => {
  it('is known for a person in contacts, whatever their tier (imported contacts start at unknown)', async () => {
    for (const tier of ['unknown', 'known', 'trusted', 'principal']) {
      expect(await contactLookupFor(resolverOf({ tier, kind: 'person' }), logger).isKnown('a@b.com')).toBe(true);
    }
  });

  it('is not known when the address is not in contacts', async () => {
    expect(await contactLookupFor(resolverOf(null), logger).isKnown('a@b.com')).toBe(false);
  });

  it('does not count companies, automated senders or blocked contacts', async () => {
    for (const found of [{ tier: 'known', kind: 'organization' }, { tier: 'known', kind: 'automated' }, { tier: 'blocked', kind: 'person' }]) {
      expect(await contactLookupFor(resolverOf(found), logger).isKnown('a@b.com')).toBe(false);
    }
  });

  it('looks up email addresses only, and not text that is not a plain address', async () => {
    const resolver = resolverOf({ tier: 'known', kind: 'person' });
    const lookup = contactLookupFor(resolver, logger);
    expect(await lookup.isKnown('Dana <a@b.com>')).toBe(false);
    expect(await lookup.isKnown('not an address')).toBe(false);
    expect(resolver.resolveByChannelIdentity).not.toHaveBeenCalled();
    await lookup.isKnown(' a@b.com ');
    expect(resolver.resolveByChannelIdentity).toHaveBeenCalledWith('email', 'a@b.com');
  });

  it('answers false and logs when the lookup fails or is too slow', async () => {
    const failing: ContactResolver = { resolveByChannelIdentity: async () => { throw new Error('db down'); } };
    expect(await contactLookupFor(failing, logger).isKnown('a@b.com')).toBe(false);
    const slow: ContactResolver = { resolveByChannelIdentity: () => new Promise(() => {}) };
    expect(await contactLookupFor(slow, logger, 20).isKnown('a@b.com')).toBe(false);
  });
});
