// import-service.test.ts — the contacts import's safety rules. Real ContactService (in memory); made-up people only.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { ContactImportService, ImportError, MAX_PEOPLE_PER_BATCH, type ImportPerson } from '../../../src/contacts-import/import-service.js';
import { InMemoryImportStore } from '../../../src/contacts-import/import-store.js';
import { normalizeEmail, normalizePhone } from '../../../src/contacts-import/normalize.js';
import { createSilentLogger } from '../../../src/logger.js';

const person = (key: string, extra: Partial<ImportPerson> = {}): ImportPerson =>
  ({ sourceKey: key, displayName: `Test Person ${key}`, emails: [`${key}@example.org`], ...extra });

describe('normalize', () => {
  it('lower-cases emails and rejects non-emails', () => {
    expect(normalizeEmail('  Jenna@Example.ORG ')).toBe('jenna@example.org');
    for (const bad of ['', 'nope', 'a@b', 'a b@c.d', 'x'.repeat(260) + '@e.org']) expect(normalizeEmail(bad)).toBeNull();
  });

  it('puts phones in E.164, defaults bare North American numbers to +1, and rejects guesses', () => {
    expect(normalizePhone('(416) 555-0100')).toBe('+14165550100');
    expect(normalizePhone('1-416-555-0100')).toBe('+14165550100');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('tel:+14165550100')).toBe('+14165550100');
    for (const bad of ['', '555-0100', '12345', '+0123456789', '+1', 'abc']) expect(normalizePhone(bad)).toBeNull();
  });
});

describe('ContactImportService', () => {
  let contacts: ContactService;
  let store: InMemoryImportStore;
  let svc: ContactImportService;

  beforeEach(() => {
    contacts = ContactService.createInMemory();
    store = new InMemoryImportStore();
    svc = new ContactImportService(contacts, store, createSilentLogger());
  });

  describe('dry run', () => {
    it('plans without writing any contact, identity or source', async () => {
      const plan = await svc.plan('b1', [person('a'), person('b')]);
      expect(plan.counts).toEqual({ create: 2, attach: 0, review: 0 });
      expect(await contacts.listContacts()).toHaveLength(0);
      expect(await store.getContactIdForSource('a')).toBeNull();
    });

    it('rejects bad batch ids and oversized batches', async () => {
      await expect(svc.plan('bad id!', [])).rejects.toMatchObject({ code: 'bad_batch_id' });
      await expect(svc.plan('b1', Array.from({ length: MAX_PEOPLE_PER_BATCH + 1 }, (_, i) => person(`p${i}`)))).rejects.toMatchObject({ code: 'too_many_people' });
    });

    it('sends invalid people and people with no usable identifier to review', async () => {
      const plan = await svc.plan('b1', [
        { sourceKey: '', displayName: 'No Key' },
        { sourceKey: 'n', displayName: '' },
        42,
        person('x', { emails: ['not-an-email'], phones: ['12345'] }),
      ]);
      expect(plan.items.map(i => (i.action === 'review' ? i.reason : i.action))).toEqual([
        'invalid_person', 'invalid_person', 'invalid_person', 'no_usable_identifier',
      ]);
    });

    it('sends a repeated person (same key or same identifier) in one batch to review', async () => {
      const plan = await svc.plan('b1', [
        person('a'),
        person('a'),
        person('b', { emails: ['a@example.org'] }),
        person('c', { emails: [], phones: ['+14165550100'] }),
        person('d', { emails: [], phones: ['(416) 555-0100'] }),
      ]);
      expect(plan.items.map(i => (i.action === 'review' ? i.reason : i.action))).toEqual([
        'create', 'duplicate_in_batch', 'duplicate_in_batch', 'create', 'duplicate_in_batch',
      ]);
    });
  });

  describe('apply', () => {
    it('needs a dry run, the same people, and works only once', async () => {
      await expect(svc.apply('nope', [person('a')])).rejects.toMatchObject({ code: 'unknown_batch' });
      await svc.plan('b1', [person('a')]);
      await expect(svc.apply('b1', [person('a'), person('b')])).rejects.toMatchObject({ code: 'payload_changed' });
      await expect(svc.apply('b1', [person('a', { displayName: 'Someone Else' })])).rejects.toMatchObject({ code: 'payload_changed' });
      const done = await svc.apply('b1', [person('a')]);
      expect(done.counts).toEqual({ created: 1, attached: 0, skipped: 0, failed: 0 });
      await expect(svc.apply('b1', [person('a')])).rejects.toMatchObject({ code: 'already_applied' });
      await expect(svc.plan('b1', [person('a')])).rejects.toBeInstanceOf(ImportError);
      expect(await contacts.listContacts()).toHaveLength(1);
    });

    it('creates contacts as tier unknown with unverified bulk_import identities, never trusted', async () => {
      const people = [person('a', { phones: ['(416) 555-0100'], suggestedLabel: 'work', organization: 'Acme', title: 'CFO' })];
      await svc.plan('b1', people);
      const res = await svc.apply('b1', people);
      const id = res.outcomes[0]!.contactId!;
      const c = (await contacts.getContact(id))!;
      expect(c).toMatchObject({ tier: 'unknown', systemRole: null, organization: 'Acme', title: 'CFO' });
      const ids = await contacts.getIdentitiesForContact(id);
      expect(ids.map(i => `${i.channel}:${i.channelIdentifier}`).sort()).toEqual(['email:a@example.org', 'phone:+14165550100']);
      for (const i of ids) expect(i).toMatchObject({ verified: false, verifiedAt: null, source: 'bulk_import', status: 'active' });
      expect(await store.getContactIdForSource('a')).toBe(id);
      expect(await store.getLabel(id)).toEqual({ suggested: 'work', label: null });
    });

    it('marks noreply senders as automated through the normal contact classification', async () => {
      const people = [person('n', { emails: ['noreply@example.org'] })];
      await svc.plan('b1', people);
      const res = await svc.apply('b1', people);
      expect((await contacts.getContact(res.outcomes[0]!.contactId!))!.kind).toBe('automated');
    });

    it('attaches to an existing contact by a shared email without changing its tier, role or verification', async () => {
      const existing = await contacts.createContact({ displayName: 'Existing Person', source: 'test', tier: 'known', role: 'Advisor' });
      await contacts.linkIdentity({ contactId: existing.id, channel: 'email', channelIdentifier: 'shared@example.org', source: 'ceo_stated' });
      const people = [person('a', { emails: ['Shared@Example.org', 'second@example.org'], phones: ['+14165550101'] })];
      const plan = await svc.plan('b1', people);
      expect(plan.items[0]).toEqual({ sourceKey: 'a', action: 'attach', contactId: existing.id });
      const res = await svc.apply('b1', people);
      expect(res.counts.attached).toBe(1);
      expect(await contacts.listContacts()).toHaveLength(1);
      const after = (await contacts.getContact(existing.id))!;
      expect(after).toMatchObject({ tier: 'known', role: 'Advisor', displayName: 'Existing Person' });
      const ids = await contacts.getIdentitiesForContact(existing.id);
      const byId = new Map(ids.map(i => [i.channelIdentifier, i]));
      expect(byId.get('shared@example.org')).toMatchObject({ verified: true, source: 'ceo_stated' }); // untouched
      expect(byId.get('second@example.org')).toMatchObject({ verified: false, source: 'bulk_import' });
      expect(byId.get('+14165550101')).toMatchObject({ verified: false, source: 'bulk_import' });
    });

    it('fills empty fields only, and sends a different value to review untouched', async () => {
      const blank = await contacts.createContact({ displayName: 'Blank Fields', source: 'test' });
      await contacts.linkIdentity({ contactId: blank.id, channel: 'email', channelIdentifier: 'blank@example.org', source: 'ceo_stated' });
      const filled = await contacts.createContact({ displayName: 'Filled Fields', source: 'test', organization: 'Real Corp', title: 'CEO' });
      await contacts.linkIdentity({ contactId: filled.id, channel: 'email', channelIdentifier: 'filled@example.org', source: 'ceo_stated' });

      const people = [
        person('a', { emails: ['blank@example.org'], organization: 'Acme', title: 'CFO' }),
        person('b', { emails: ['filled@example.org'], organization: 'Other Corp' }),
        person('c', { emails: ['filled@example.org'].map(() => 'filled2@example.org'), phones: [] }),
      ];
      const plan = await svc.plan('b1', people.slice(0, 2));
      expect(plan.items[0]).toMatchObject({ action: 'attach' });
      expect(plan.items[1]).toEqual({ sourceKey: 'b', action: 'review', reason: 'field_differs', contactId: filled.id });
      await svc.apply('b1', people.slice(0, 2));
      expect(await contacts.getContact(blank.id)).toMatchObject({ organization: 'Acme', title: 'CFO' });
      expect(await contacts.getContact(filled.id)).toMatchObject({ organization: 'Real Corp', title: 'CEO' });
      expect(await contacts.getIdentitiesForContact(filled.id)).toHaveLength(1);
    });

    it('never moves an identifier that belongs to another contact: identifiers spanning two contacts go to review', async () => {
      const one = await contacts.createContact({ displayName: 'Person One', source: 'test' });
      const two = await contacts.createContact({ displayName: 'Person Two', source: 'test' });
      await contacts.linkIdentity({ contactId: one.id, channel: 'email', channelIdentifier: 'one@example.org', source: 'ceo_stated' });
      await contacts.linkIdentity({ contactId: two.id, channel: 'phone', channelIdentifier: '+14165550102', source: 'ceo_stated' });
      const people = [person('a', { emails: ['one@example.org'], phones: ['+14165550102'] })];
      const plan = await svc.plan('b1', people);
      expect(plan.items[0]).toEqual({ sourceKey: 'a', action: 'review', reason: 'identifiers_span_contacts' });
      const res = await svc.apply('b1', people);
      expect(res.outcomes[0]).toMatchObject({ outcome: 'skipped', reason: 'identifiers_span_contacts' });
      expect((await contacts.getIdentitiesForContact(one.id)).map(i => i.channelIdentifier)).toEqual(['one@example.org']);
      expect((await contacts.getIdentitiesForContact(two.id)).map(i => i.channelIdentifier)).toEqual(['+14165550102']);
    });

    it('matches a phone already on file under another phone channel (signal, sms)', async () => {
      const c = await contacts.createContact({ displayName: 'Signal Person', source: 'test' });
      await contacts.linkIdentity({ contactId: c.id, channel: 'signal', channelIdentifier: '+14165550103', source: 'signal_participant' });
      const plan = await svc.plan('b1', [person('a', { emails: [], phones: ['+14165550103'] })]);
      expect(plan.items[0]).toEqual({ sourceKey: 'a', action: 'attach', contactId: c.id });
    });

    it('never touches the principal, an agent or a system contact', async () => {
      const principal = await contacts.createContact({ displayName: 'The Principal', source: 'test' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      await contacts.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'boss@example.org', source: 'ceo_stated' });
      const agent = await contacts.createContact({ displayName: 'An Agent', source: 'test', kind: 'agent' });
      await contacts.linkIdentity({ contactId: agent.id, channel: 'email', channelIdentifier: 'bot@example.org', source: 'ceo_stated' });

      const people = [person('a', { emails: ['boss@example.org', 'new@example.org'] }), person('b', { emails: ['bot@example.org'], phones: ['+14165550104'] })];
      const plan = await svc.plan('b1', people);
      expect(plan.items.map(i => (i.action === 'review' ? i.reason : i.action))).toEqual(['protected_contact', 'protected_contact']);
      await svc.apply('b1', people);
      expect(await contacts.getIdentitiesForContact(principal.id)).toHaveLength(1);
      expect(await contacts.getIdentitiesForContact(agent.id)).toHaveLength(1);
    });

    it('skips a person whose situation changed between the dry run and the apply', async () => {
      const people = [person('a', { emails: ['late@example.org'] }), person('b')];
      const plan = await svc.plan('b1', people);
      expect(plan.items[0]).toMatchObject({ action: 'create' });
      // Someone else now owns that address.
      const other = await contacts.createContact({ displayName: 'Arrived Meanwhile', source: 'test' });
      await contacts.linkIdentity({ contactId: other.id, channel: 'email', channelIdentifier: 'late@example.org', source: 'ceo_stated' });
      const res = await svc.apply('b1', people);
      expect(res.outcomes[0]).toMatchObject({ outcome: 'skipped', reason: 'changed_since_dry_run' });
      expect(res.outcomes[1]).toMatchObject({ outcome: 'created' });
      expect(await contacts.getIdentitiesForContact(other.id)).toHaveLength(1);
    });

    it('re-sending the same record updates the same contact instead of creating a duplicate', async () => {
      const first = [person('rec-1', { emails: [], phones: ['+14165550105'] })];
      await svc.plan('b1', first);
      const id = (await svc.apply('b1', first)).outcomes[0]!.contactId!;
      const again = [person('rec-1', { emails: ['added@example.org'], phones: ['+14165550105'], suggestedLabel: 'hybrid' })];
      const plan = await svc.plan('b2', again);
      expect(plan.items[0]).toEqual({ sourceKey: 'rec-1', action: 'attach', contactId: id });
      await svc.apply('b2', again);
      expect(await contacts.listContacts()).toHaveLength(1);
      expect((await contacts.getIdentitiesForContact(id)).map(i => i.channelIdentifier).sort()).toEqual(['+14165550105', 'added@example.org']);
      expect(await store.getLabel(id)).toEqual({ suggested: 'hybrid', label: null });
    });

    it('sends a record whose identifiers now belong to a different contact than before to review', async () => {
      const first = [person('rec-1', { emails: ['mine@example.org'] })];
      await svc.plan('b1', first);
      await svc.apply('b1', first);
      const other = await contacts.createContact({ displayName: 'Other Owner', source: 'test' });
      await contacts.linkIdentity({ contactId: other.id, channel: 'email', channelIdentifier: 'theirs@example.org', source: 'ceo_stated' });
      const plan = await svc.plan('b2', [person('rec-1', { emails: ['theirs@example.org'] })]);
      expect(plan.items[0]).toMatchObject({ action: 'review', reason: 'source_key_conflict' });
    });
  });

  describe('verification', () => {
    it('keeps bulk_import identities unverified even when linked directly', async () => {
      const c = await contacts.createContact({ displayName: 'Direct Link', source: 'test' });
      const id = await contacts.linkIdentity({ contactId: c.id, channel: 'email', channelIdentifier: 'direct@example.org', source: 'bulk_import' });
      expect(id).toMatchObject({ verified: false, verifiedAt: null });
    });
  });
});
