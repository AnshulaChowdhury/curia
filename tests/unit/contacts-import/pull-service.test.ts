// pull-service.test.ts — Preview and Apply. Real ContactService (in memory) and the real import service; made-up people.
// The properties that matter: a preview writes nothing; Apply does only what was previewed, once, as tier `unknown`;
// a source that fails does not stop the others; an old preview cannot be applied.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { ContactImportService, MAX_PEOPLE_PER_BATCH } from '../../../src/contacts-import/import-service.js';
import { InMemoryImportStore } from '../../../src/contacts-import/import-store.js';
import { InMemoryRunStore } from '../../../src/contacts-import/run-store.js';
import { ContactsPullService, PREVIEW_TTL_MS, PullError, type Collector } from '../../../src/contacts-import/pull-service.js';
import type { Candidate } from '../../../src/contacts-import/merge.js';
import { createSilentLogger } from '../../../src/logger.js';

const cand = (n: number, extra: Partial<Candidate> = {}): Candidate => ({
  sourceKey: `bridge:whatsapp:${n}`, sourceId: 'bridge:whatsapp', displayName: `Test Person ${n}`, emails: [],
  phones: [`+1416555${String(1000 + n).padStart(4, '0')}`], ...extra,
});
const collector = (sourceId: string, candidates: Candidate[], over: Partial<Collector> = {}): Collector => ({
  sourceId, label: sourceId, collect: async () => ({ ok: true, message: 'Read.', read: candidates.length, candidates }), ...over,
});

describe('ContactsPullService', () => {
  let contacts: ContactService;
  let runs: InMemoryRunStore;
  let clock: number;
  const build = (collectors: Collector[]) =>
    new ContactsPullService(new ContactImportService(contacts, new InMemoryImportStore(), createSilentLogger()), runs, collectors, createSilentLogger(), () => clock);

  beforeEach(() => {
    contacts = ContactService.createInMemory();
    runs = new InMemoryRunStore();
    clock = Date.parse('2026-11-02T12:00:00Z');
  });

  it('a preview counts what would happen and writes no contact', async () => {
    const svc = build([collector('bridge:whatsapp', [cand(1), cand(2), cand(3)])]);
    const p = await svc.preview();
    expect(p.totals).toEqual({ people: 3, create: 3, attach: 0, review: 0 });
    expect(await contacts.listContacts()).toHaveLength(0);
    expect(p.sample.create).toHaveLength(3);
  });

  it('the sample masks numbers and addresses', async () => {
    const svc = build([collector('mailbox:x', [cand(1, { phones: [], emails: ['dana@example.org'] }), cand(2)])]);
    const p = await svc.preview();
    const json = JSON.stringify(p.sample);
    expect(json).not.toContain('dana@example.org');
    expect(json).not.toContain('+14165551002');
    expect(json).toContain('d***@example.org');
  });

  it('apply creates exactly the previewed people as tier unknown, and only once', async () => {
    const svc = build([collector('bridge:whatsapp', [cand(1), cand(2)])]);
    const p = await svc.preview();
    const done = await svc.apply(p.runId);
    expect(done.totals).toEqual({ created: 2, attached: 0, skipped: 0, failed: 0 });
    const all = await contacts.listContacts();
    expect(all).toHaveLength(2);
    expect(all.every((c) => c.tier === 'unknown')).toBe(true);
    await expect(svc.apply(p.runId)).rejects.toMatchObject({ code: 'unknown_run' });
    expect(await contacts.listContacts()).toHaveLength(2);
  });

  it('merges the same person found in two sources before planning', async () => {
    const svc = build([
      collector('bridge:whatsapp', [cand(1)]),
      collector('bridge:signal', [cand(1, { sourceKey: 'bridge:signal:9', sourceId: 'bridge:signal', displayName: 'Test Person One' })]),
    ]);
    const p = await svc.preview();
    expect(p.totals.people).toBe(1);
    expect(p.sources.map((s) => s.sourceId)).toEqual(['bridge:whatsapp', 'bridge:signal']);
  });

  it('a person already in Curia is attached, not duplicated, and the tier is untouched', async () => {
    const existing = await contacts.createContact({ displayName: 'Test Person 1', source: 'test', tier: 'known' });
    await contacts.linkIdentity({ contactId: existing.id, channel: 'phone', channelIdentifier: '+14165551001', source: 'ceo_stated' });
    const svc = build([collector('bridge:whatsapp', [cand(1), cand(2)])]);
    const p = await svc.preview();
    expect(p.totals).toMatchObject({ create: 1, attach: 1 });
    await svc.apply(p.runId);
    expect(await contacts.listContacts()).toHaveLength(2);
    expect((await contacts.getContact(existing.id))?.tier).toBe('known');
  });

  it('one failing source does not stop the others, and is reported', async () => {
    const svc = build([
      collector('bridge:signal', [], { collect: async () => ({ ok: false, message: 'Nobody is logged in to this bridge yet.', read: 0, candidates: [] }) }),
      collector('bridge:gmessages', [], { collect: async () => { throw new Error('boom'); } }),
      collector('bridge:whatsapp', [cand(1)]),
    ]);
    const p = await svc.preview();
    expect(p.totals.people).toBe(1);
    expect(p.sources.map((s) => [s.sourceId, s.ok])).toEqual([['bridge:signal', false], ['bridge:gmessages', false], ['bridge:whatsapp', true]]);
    expect(JSON.stringify(p.sources)).not.toContain('boom');
  });

  it('says so when nothing was found, and saves nothing', async () => {
    const svc = build([collector('bridge:whatsapp', [])]);
    await expect(svc.preview()).rejects.toBeInstanceOf(PullError);
    await expect(svc.preview()).rejects.toMatchObject({ code: 'nothing_to_import' });
  });

  it('splits a large run into batches of at most 500 and applies them all', async () => {
    const many = Array.from({ length: MAX_PEOPLE_PER_BATCH + 20 }, (_, i) => cand(i));
    const svc = build([collector('bridge:whatsapp', many)]);
    const p = await svc.preview();
    expect(p.totals.people).toBe(MAX_PEOPLE_PER_BATCH + 20);
    expect((await runs.getRun(p.runId))).toHaveLength(2);
    const done = await svc.apply(p.runId);
    expect(done.totals.created).toBe(MAX_PEOPLE_PER_BATCH + 20);
  });

  it('refuses a preview older than 24 hours and discards it', async () => {
    const svc = build([collector('bridge:whatsapp', [cand(1)])]);
    const p = await svc.preview();
    clock += PREVIEW_TTL_MS + 1;
    // The in-memory store stamps real time; make the stored preview look old by re-saving with the fake clock's past.
    const chunks = await runs.getRun(p.runId);
    (chunks[0] as { createdAt: string }).createdAt = new Date(clock - PREVIEW_TTL_MS - 1000).toISOString();
    const svc2 = new ContactsPullService(new ContactImportService(contacts, new InMemoryImportStore(), createSilentLogger()), {
      ...runs, savePayload: runs.savePayload.bind(runs), getRun: async () => chunks, deleteRun: (id: string) => runs.deleteRun(id),
    }, [], createSilentLogger(), () => clock);
    await expect(svc2.apply(p.runId)).rejects.toMatchObject({ code: 'preview_expired' });
    expect(await contacts.listContacts()).toHaveLength(0);
    expect(await runs.getRun(p.runId)).toHaveLength(0);
  });

  it('an unknown run id applies nothing', async () => {
    await expect(build([]).apply('pull-zzz-deadbeef')).rejects.toMatchObject({ code: 'unknown_run' });
  });
});
