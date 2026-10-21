// Pure tests for the KG node-merge planner (spec §4, §5, §8, §12).
import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  computeAliases,
  factConflictId,
  nearDuplicateId,
  planNodeMerge,
  planToken,
} from '../../../src/kg-merge/planner.js';
import {
  A_ID,
  S_ID,
  basicPair,
  makeContact,
  makeEdge,
  makeFact,
  makeNode,
  makeSide,
  makeSnapshot,
  uid,
} from './fixtures.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

describe('planNodeMerge — labels and aliases', () => {
  it('defaults to the survivor label and folds the absorbed label and aliases into aliases', () => {
    const { survivor, absorbed } = basicPair({ aliases: ['jane'] }, { aliases: ['Janie', 'JANE'] });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(plan.preview.result.defaultLabel).toBe('survivor');
    expect(plan.preview.result.labels).toEqual({ survivor: 'Jane Doe', absorbed: 'J. Doe' });
    // survivor aliases, then the unchosen label, then absorbed aliases; lower-cased, deduped
    expect(plan.preview.result.aliases).toEqual(['jane', 'j. doe', 'janie']);
    expect(plan.preview.result.droppedAliases).toEqual([]);
  });

  it('puts the survivor label in the aliases when the absorbed label is chosen, and drops the final label', () => {
    const r = computeAliases(
      { label: 'Jane Doe', aliases: ['j. doe'] },
      { label: 'J. Doe', aliases: [] },
      'absorbed',
    );
    expect(r.label).toBe('J. Doe');
    expect(r.aliases).toEqual(['jane doe']);
  });

  it('caps aliases at 10 and reports the overflow as droppedAliases', () => {
    const survivorAliases = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const absorbedAliases = ['a0', 'a1', 'a2'];
    const r = computeAliases({ label: 'S', aliases: survivorAliases }, { label: 'A', aliases: absorbedAliases }, 'survivor');
    expect(r.aliases).toHaveLength(10);
    expect(r.aliases.slice(0, 9)).toEqual([...survivorAliases, 'a']);
    expect(r.droppedAliases).toEqual(['a1', 'a2']);
  });

  it('warns about a label collision with a third node, but only for a label-tier result', () => {
    const { survivor, absorbed } = basicPair({ type: 'organization', label: 'Acme Inc' }, { type: 'event', label: 'Acme' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed), uid(99), 'ACME'));
    expect(plan.preview.warnings.map(w => w.code)).toContain('label_collision');
    // Human-readable: the third node's label and type, never its id.
    expect(plan.preview.warnings.find(w => w.code === 'label_collision')!.details).toEqual(['ACME (organization)']);
    expect(plan.preview.blockers).toEqual([]);

    // A person survivor that ends up with a contact is contact-anchored: no collision.
    const p = basicPair({}, {});
    const withContact = makeSide(p.survivor, { contacts: [makeContact({ id: uid(10), kgNodeId: S_ID })] });
    const plan2 = planNodeMerge(makeSnapshot(withContact, makeSide(p.absorbed), uid(99)));
    expect(plan2.preview.warnings.map(w => w.code)).not.toContain('label_collision');
  });
});

describe('planNodeMerge — properties', () => {
  it('unions properties, skips reserved keys, and flags deep-unequal values as conflicts', () => {
    const { survivor, absorbed } = basicPair(
      { properties: { role: 'CEO', tags: { a: 1, b: 2 } }, lastConfirmedAt: T1 },
      { properties: { role: 'CTO', tags: { b: 2, a: 1 }, city: 'Paris', merged_into: uid(5), is_agent: 'true', merged_at: T1 }, lastConfirmedAt: T2 },
    );
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(plan.node.mergedProperties).toEqual({ role: 'CEO', tags: { a: 1, b: 2 }, city: 'Paris' });
    expect(plan.preview.conflicts.properties).toEqual([
      { key: 'role', survivorValue: 'CEO', absorbedValue: 'CTO', default: 'absorbed' },
    ]);
    // is_agent on the absorbed side is still an agent guard, independent of copying.
    expect(plan.preview.blockers.map(b => b.code)).toContain('agent_node');
  });

  it('defaults a property conflict to the survivor on a last_confirmed_at tie', () => {
    const { survivor, absorbed } = basicPair({ properties: { x: 1 } }, { properties: { x: 2 } });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(plan.preview.conflicts.properties[0]!.default).toBe('survivor');
  });
});

describe('planNodeMerge — scalars', () => {
  it('takes max confidence, most durable decay, max sensitivity, min created, max confirmed', () => {
    const { survivor, absorbed } = basicPair(
      { confidence: 0.6, decayClass: 'fast_decay', sensitivity: 'internal', createdAt: T2, lastConfirmedAt: T2 },
      { confidence: 0.9, decayClass: 'permanent', sensitivity: 'confidential', createdAt: T1, lastConfirmedAt: T3, warnedAt: T1, warnReason: 'high_sensitivity' },
    );
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(plan.node).toMatchObject({
      confidence: 0.9,
      decayClass: 'permanent',
      sensitivity: 'confidential',
      createdAt: T1,
      lastConfirmedAt: T3,
      warnedAt: T1,
      warnReason: 'high_sensitivity',
      identitySource: 'label',
    });
    expect(plan.preview.result).toMatchObject({ confidence: 0.9, decayClass: 'permanent', sensitivity: 'confidential' });
  });

  it('never lowers sensitivity and keeps the survivor warning when set', () => {
    const { survivor, absorbed } = basicPair(
      { sensitivity: 'restricted', warnedAt: T2, warnReason: 'both' },
      { sensitivity: 'public', warnedAt: T1, warnReason: 'high_connectivity' },
    );
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(plan.node.sensitivity).toBe('restricted');
    expect(plan.node).toMatchObject({ warnedAt: T2, warnReason: 'both' });
  });

  it('anchors a person survivor that ends up with a contact, clearing a pending decay warning', () => {
    const { survivor, absorbed } = basicPair({ warnedAt: T1, warnReason: 'high_sensitivity' });
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor),
      makeSide(absorbed, { contacts: [makeContact({ id: uid(20), kgNodeId: A_ID })] }),
    ));
    expect(plan.node.identitySource).toBe('contact');
    expect(plan.node.warnedAt).toBeNull();
    expect(plan.preview.result.identitySource).toBe('contact');
  });

  it('flags cross-type merges and keeps the survivor type', () => {
    const { survivor, absorbed } = basicPair({ type: 'organization', label: 'Acme' }, { type: 'event', label: 'Acme Summit' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(plan.preview.crossType).toBe(true);
    expect(plan.preview.result.type).toBe('organization');
  });
});

describe('planNodeMerge — facts', () => {
  it('collapses an attribute fact with the same normalized value', () => {
    const { survivor, absorbed } = basicPair();
    const sFact = makeFact(uid(100), 'Lives in Paris', { attribute: 'City', value: 'Paris' });
    const aFact = makeFact(uid(101), 'Based in paris', { attribute: ' city ', value: 'PARIS ' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [sFact] }), makeSide(absorbed, { facts: [aFact] })));
    expect(plan.facts.collapses).toHaveLength(1);
    expect(plan.facts.collapses[0]!.survivorFact.id).toBe(uid(100));
    expect(plan.facts.conflicts).toEqual([]);
    expect(plan.preview.summary).toMatchObject({ factsCollapsed: 1, factsMoved: 0 });
  });

  it('turns different attribute values into a conflict defaulting to the newer fact', () => {
    const { survivor, absorbed } = basicPair();
    const sFact = makeFact(uid(100), 'Title: CEO', { attribute: 'title', value: 'CEO' }, { lastConfirmedAt: T1 });
    const aFact = makeFact(uid(101), 'Title: CTO', { attribute: 'title', value: 'CTO' }, { lastConfirmedAt: T2 });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [sFact] }), makeSide(absorbed, { facts: [aFact] })));
    expect(plan.preview.conflicts.facts).toHaveLength(1);
    const c = plan.preview.conflicts.facts[0]!;
    expect(c.id).toBe(factConflictId(uid(100), uid(101)));
    expect(c.id).toBe(`fact:${uid(100)}:${uid(101)}`);
    expect(c.attribute).toBe('title');
    expect(c.default).toBe('absorbed');
    expect(c.survivor).toMatchObject({ value: 'CEO', attribute: 'title' });
  });

  it('compares only the newest fact on each side; the other absorbed facts move', () => {
    const { survivor, absorbed } = basicPair();
    const s1 = makeFact(uid(100), 'old title', { attribute: 'title', value: 'VP' }, { lastConfirmedAt: T1 });
    const s2 = makeFact(uid(101), 'new title', { attribute: 'title', value: 'CEO' }, { lastConfirmedAt: T3 });
    const a1 = makeFact(uid(102), 'a old', { attribute: 'title', value: 'Intern' }, { lastConfirmedAt: T1 });
    const a2 = makeFact(uid(103), 'a new', { attribute: 'title', value: 'CTO' }, { lastConfirmedAt: T2 });
    const a3 = makeFact(uid(104), 'a dup', { attribute: 'title', value: 'vp' }, { lastConfirmedAt: T1 });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [s1, s2] }), makeSide(absorbed, { facts: [a1, a2, a3] })));
    expect(plan.facts.conflicts.map(c => c.id)).toEqual([factConflictId(uid(101), uid(103))]);
    expect(plan.facts.conflicts[0]!.default).toBe('survivor');
    expect(plan.facts.moves.map(m => m.fact.id)).toEqual([uid(102)]);
    // a3 matches the older survivor value → duplicate of s1
    expect(plan.facts.collapses.map(c => [c.survivorFact.id, c.absorbedFact.id])).toEqual([[uid(100), uid(104)]]);
  });

  it('moves differing values of a multi-valued attribute instead of conflicting', () => {
    const { survivor, absorbed } = basicPair();
    const s = makeFact(uid(100), 'email a', { attribute: 'email', value: 'a@x.com', multi_valued: true });
    const a = makeFact(uid(101), 'email b', { attribute: 'email', value: 'b@x.com', multi_valued: true });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [s] }), makeSide(absorbed, { facts: [a] })));
    expect(plan.facts.conflicts).toEqual([]);
    expect(plan.facts.moves.map(m => m.fact.id)).toEqual([uid(101)]);
  });

  it('keeps a fact linked to both sides once and drops the absorbed link', () => {
    const { survivor, absorbed } = basicPair();
    const sharedS = makeFact(uid(100), 'Met at the summit', {}, {}, ['link-s']);
    const sharedA = makeFact(uid(100), 'Met at the summit', {}, {}, ['link-a']);
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [sharedS] }), makeSide(absorbed, { facts: [sharedA] })));
    expect(plan.facts.sharedFactIds).toEqual([uid(100)]);
    expect(plan.facts.sharedLinkEdgeIds).toEqual(['link-a']);
    expect(plan.facts.moves).toEqual([]);
    expect(plan.facts.collapses).toEqual([]);
  });

  it('collapses exact duplicate non-attribute facts after normalization', () => {
    const { survivor, absorbed } = basicPair();
    const s = makeFact(uid(100), 'Loves  sailing.');
    const a = makeFact(uid(101), 'loves sailing!');
    const other = makeFact(uid(102), 'Has two dogs');
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [s] }), makeSide(absorbed, { facts: [a, other] })));
    expect(plan.facts.collapses.map(c => c.absorbedFact.id)).toEqual([uid(101)]);
    expect(plan.facts.moves.map(m => m.fact.id)).toEqual([uid(102)]);
    expect(plan.preview.summary).toMatchObject({ factsMoved: 1, factsCollapsed: 1 });
  });

  it('pairs near-duplicates by embedding (best match only) and skips null embeddings', () => {
    const { survivor, absorbed } = basicPair();
    const s1 = makeFact(uid(100), 'Enjoys sailing on weekends', {}, { embedding: [1, 0, 0] });
    const s2 = makeFact(uid(101), 'Likes boats', {}, { embedding: [0.97, 0.243, 0] });
    const a1 = makeFact(uid(102), 'Goes sailing at weekends', {}, { embedding: [0.999, 0.04, 0] });
    const aNull = makeFact(uid(103), 'No embedding here', {}, { embedding: null });
    const aFar = makeFact(uid(104), 'Allergic to cats', {}, { embedding: [0, 0, 1] });
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor, { facts: [s1, s2] }),
      makeSide(absorbed, { facts: [a1, aNull, aFar] }),
    ));
    expect(plan.preview.conflicts.nearDuplicateFacts).toHaveLength(1);
    const n = plan.preview.conflicts.nearDuplicateFacts[0]!;
    expect(n.id).toBe(nearDuplicateId(uid(100), uid(102)));
    expect(n.id.startsWith('near:')).toBe(true);
    expect(n.default).toBe('merge');
    expect(n.similarity).toBeGreaterThanOrEqual(0.92);
    expect(plan.facts.moves.map(m => m.fact.id).sort()).toEqual([uid(103), uid(104)]);
  });
});

describe('planNodeMerge — edges', () => {
  it('drops edges between the two nodes, collapses collisions, and moves the rest', () => {
    const { survivor, absorbed } = basicPair();
    const X = uid(50);
    const Y = uid(51);
    const selfLoop = makeEdge(uid(200), A_ID, S_ID, 'collaborates_with');
    const collide = makeEdge(uid(201), X, A_ID, 'works_on');
    const survivorTwin = makeEdge(uid(202), S_ID, X, 'works_on');
    const move = makeEdge(uid(203), A_ID, Y, 'member_of');
    const sameOtherDifferentType = makeEdge(uid(204), A_ID, X, 'advises');
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor, { edges: [selfLoop, survivorTwin] }),
      makeSide(absorbed, { edges: [selfLoop, collide, move, sameOtherDifferentType] }),
    ));
    expect(plan.edges.dropped.map(e => e.id)).toEqual([uid(200)]);
    expect(plan.edges.collapsed.map(c => [c.absorbedEdge.id, c.survivorEdge.id])).toEqual([[uid(201), uid(202)]]);
    expect(plan.edges.moved.map(e => e.id)).toEqual([uid(203), uid(204)]);
    expect(plan.preview.summary).toMatchObject({ edgesMoved: 2, edgesCollapsed: 1, edgesDropped: 1 });
  });
});

describe('planNodeMerge — contact plan matrix', () => {
  it('person + person: folds the absorbed contact into the survivor contact with field and override conflicts', () => {
    const { survivor, absorbed } = basicPair();
    const cs = makeContact({
      id: uid(10), kgNodeId: S_ID, displayName: 'Jane Doe',
      fields: { title: 'CEO', timezone: 'America/Toronto', primary_email: 'jane@x.com' },
      identities: [{ id: uid(30), channel: 'email', identifier: 'jane@x.com', verified: true }],
      authOverrides: [{ permission: 'send_email', granted: true }],
    });
    const ca = makeContact({
      id: uid(11), kgNodeId: A_ID, displayName: 'J. Doe',
      fields: { title: 'CTO', location: 'Paris', primary_email: 'JANE@x.com' },
      identities: [
        { id: uid(31), channel: 'email', identifier: 'Jane@X.com', verified: false },
        { id: uid(32), channel: 'signal', identifier: '+15550001', verified: true },
      ],
      authOverrides: [{ permission: 'send_email', granted: false }, { permission: 'calendar', granted: true }],
    });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { contacts: [cs] }), makeSide(absorbed, { contacts: [ca] })));
    expect(plan.preview.contactPlan).toMatchObject({
      action: 'merge',
      survivingContactId: uid(10),
      mergedContactIds: [uid(11)],
      repointedContactIds: [],
      resultingKind: 'person',
    });
    expect(plan.preview.conflicts.contactFields).toEqual([
      { field: 'title', label: 'Title', survivorValue: 'CEO', absorbedValue: 'CTO', default: 'survivor' },
    ]);
    expect(plan.contacts.fieldBase).toMatchObject({ title: 'CEO', location: 'Paris', timezone: 'America/Toronto', primary_email: 'jane@x.com' });
    expect(plan.preview.conflicts.authOverrides).toEqual([
      { permission: 'send_email', survivorGranted: true, absorbedGranted: false, default: 'survivor' },
    ]);
    expect(plan.preview.contactPlan.identities).toEqual([
      { channel: 'email', identifier: 'jane@x.com', from: 'survivor', duplicate: false, verified: true },
      { channel: 'email', identifier: 'Jane@X.com', from: 'absorbed', duplicate: true, verified: false },
      { channel: 'signal', identifier: '+15550001', from: 'absorbed', duplicate: false, verified: true },
    ]);
    expect(plan.preview.blockers).toEqual([]);
  });

  it('person survivor without a contact adopts the earliest absorbed contact by re-pointing it', () => {
    const { survivor, absorbed } = basicPair();
    const older = makeContact({ id: uid(12), kgNodeId: A_ID, kind: 'organization', createdAt: T1 });
    const newer = makeContact({ id: uid(11), kgNodeId: A_ID, kind: 'organization', createdAt: T2 });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed, { contacts: [newer, older] })));
    expect(plan.preview.contactPlan).toMatchObject({
      action: 'merge',
      survivingContactId: uid(12),
      mergedContactIds: [uid(11)],
      repointedContactIds: [uid(12)],
      resultingKind: 'person',
    });
    expect(plan.contacts.repointed).toEqual([{ contact: older, kind: 'person' }]);
  });

  it('person survivor with one absorbed contact and none of its own is a pure re-point', () => {
    const { survivor, absorbed } = basicPair();
    const ca = makeContact({ id: uid(11), kgNodeId: A_ID });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed, { contacts: [ca] })));
    expect(plan.preview.contactPlan).toMatchObject({ action: 'repoint', survivingContactId: uid(11), repointedContactIds: [uid(11)] });
  });

  it('blocks a person survivor that already has several contacts', () => {
    const { survivor, absorbed } = basicPair();
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor, { contacts: [makeContact({ id: uid(10), kgNodeId: S_ID }), makeContact({ id: uid(13), kgNodeId: S_ID, createdAt: T2 })] }),
      makeSide(absorbed),
    ));
    expect(plan.preview.blockers.map(b => b.code)).toContain('survivor_multiple_contacts');
  });

  it('blocks folding away a structural contact', () => {
    const { survivor, absorbed } = basicPair();
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor, { contacts: [makeContact({ id: uid(10), kgNodeId: S_ID })] }),
      makeSide(absorbed, { contacts: [makeContact({ id: uid(11), kgNodeId: A_ID, systemRole: 'system' })] }),
    ));
    expect(plan.preview.blockers.map(b => b.code)).toContain('absorbed_structural_contact');
  });

  it('organization survivor re-points every absorbed contact as an organization contact', () => {
    const { survivor, absorbed } = basicPair({ type: 'organization', label: 'Acme' }, { type: 'person', label: 'Acme (person)' });
    const c1 = makeContact({ id: uid(11), kgNodeId: A_ID, kind: 'person' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed, { contacts: [c1] })));
    expect(plan.preview.contactPlan).toMatchObject({
      action: 'repoint',
      survivingContactId: null,
      mergedContactIds: [],
      repointedContactIds: [uid(11)],
      resultingKind: 'organization',
    });
    expect(plan.contacts.repointed[0]!.kind).toBe('organization');
    const info = plan.preview.warnings.find(w => w.code === 'contacts_repointed');
    expect(info).toMatchObject({ requiresAck: false });
    expect(plan.node.identitySource).toBe('label');
  });

  it('blocks an absorbed node with contacts when the survivor type cannot hold them, and suggests a swap', () => {
    const { survivor, absorbed } = basicPair({ type: 'event', label: 'Summit' }, { type: 'person' });
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor),
      makeSide(absorbed, { contacts: [makeContact({ id: uid(11), kgNodeId: A_ID })] }),
    ));
    expect(plan.preview.blockers.map(b => b.code)).toContain('absorbed_has_contacts_incompatible_type');
    expect(plan.preview.suggestedDirection.swap).toBe(true);
  });

  describe('folded contacts that disagree where the survivor holds nothing (contacts_disagree)', () => {
    const cs = makeContact({ id: uid(10), kgNodeId: S_ID, displayName: 'Jane Doe', fields: { location: 'Paris' } });

    function disagreePlan(first: { title: string | null; granted: boolean }, second: { title: string | null; granted: boolean }) {
      const { survivor, absorbed } = basicPair();
      // Listed newest-first to prove the earliest-created contact wins, not list order.
      const ca2 = makeContact({
        id: uid(12), kgNodeId: A_ID, displayName: 'J. Doe', createdAt: T2,
        fields: { title: second.title, location: 'Lyon' },
        authOverrides: [{ permission: 'calendar.write', granted: second.granted }],
      });
      const ca1 = makeContact({
        id: uid(11), kgNodeId: A_ID, displayName: 'Jane D.', createdAt: T1,
        fields: { title: first.title },
        authOverrides: [{ permission: 'calendar.write', granted: first.granted }],
      });
      return planNodeMerge(makeSnapshot(makeSide(survivor, { contacts: [cs] }), makeSide(absorbed, { contacts: [ca2, ca1] })));
    }

    it('keeps the earliest contact’s field value, lets the deny win, and explains both', () => {
      const plan = disagreePlan({ title: 'CTO', granted: true }, { title: 'VP Eng', granted: false });
      expect(plan.contacts.fieldBase.title).toBe('CTO');
      // The survivor holds a location, so Lyon is an ordinary choosable conflict instead.
      expect(plan.contacts.fieldBase.location).toBe('Paris');
      expect(plan.preview.conflicts.contactFields.map(c => c.field)).toEqual(['location']);
      expect(plan.preview.conflicts.authOverrides).toEqual([]);
      // The earlier fold carries the grant in, so the deny must be preferred at its fold.
      expect(plan.contacts.foldOverridePreferences).toEqual([{ permission: 'calendar.write', contactId: uid(12) }]);
      const warning = plan.preview.warnings.find(w => w.code === 'contacts_disagree');
      expect(warning).toMatchObject({ requiresAck: false });
      expect(warning!.details).toEqual([
        "Title: 'CTO' (Jane D.) kept over 'VP Eng' (J. Doe)",
        'calendar.write: denied kept over granted',
      ]);
    });

    it('needs no fold preference when the first folded contact already denies', () => {
      const plan = disagreePlan({ title: 'CTO', granted: false }, { title: 'CTO', granted: true });
      expect(plan.contacts.foldOverridePreferences).toEqual([]);
      expect(plan.preview.warnings.find(w => w.code === 'contacts_disagree')!.details).toEqual([
        'calendar.write: denied kept over granted',
      ]);
    });

    it('does not warn when the folded contacts agree', () => {
      const plan = disagreePlan({ title: 'CTO', granted: true }, { title: 'CTO', granted: true });
      expect(plan.preview.warnings.map(w => w.code)).not.toContain('contacts_disagree');
      expect(plan.contacts.foldOverridePreferences).toEqual([]);
    });
  });

  it('leaves the survivor contacts alone for other types with no absorbed contacts', () => {
    const { survivor, absorbed } = basicPair({ type: 'project', label: 'Apollo' }, { type: 'project', label: 'Project Apollo' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(plan.preview.contactPlan.action).toBe('none');
    expect(plan.preview.blockers).toEqual([]);
  });
});

describe('planNodeMerge — principal and agent guards', () => {
  it('blocks absorbing the principal node and suggests swapping', () => {
    const { survivor, absorbed } = basicPair();
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor),
      makeSide(absorbed, { contacts: [makeContact({ id: uid(11), kgNodeId: A_ID, systemRole: 'principal', kind: 'principal', tier: 'principal' })] }),
    ));
    expect(plan.preview.blockers.map(b => b.code)).toContain('absorbed_is_principal');
    expect(plan.preview.suggestedDirection.swap).toBe(true);
    expect(plan.preview.suggestedDirection.reason).toMatch(/principal/);
  });

  it('warns (requiresAck) when identities would become principal identities', () => {
    const { survivor, absorbed } = basicPair();
    const principal = makeContact({
      id: uid(10), kgNodeId: S_ID, systemRole: 'principal', kind: 'principal', tier: 'principal',
      identities: [{ id: uid(30), channel: 'email', identifier: 'me@x.com', verified: true }],
    });
    const dup = makeContact({
      id: uid(11), kgNodeId: A_ID,
      identities: [
        { id: uid(31), channel: 'email', identifier: 'ME@x.com', verified: true },
        { id: uid(32), channel: 'sms', identifier: '+15550002', verified: false },
      ],
    });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { contacts: [principal] }), makeSide(absorbed, { contacts: [dup] })));
    const w = plan.preview.warnings.find(x => x.code === 'principal_identity_transfer');
    expect(w).toMatchObject({ requiresAck: true, details: ['sms: +15550002'] });
    expect(plan.preview.blockers).toEqual([]);
    expect(plan.preview.contactPlan.resultingKind).toBe('principal');
  });

  it('blocks the agent node on either side (is_agent property or agent contact)', () => {
    const { survivor, absorbed } = basicPair({ properties: { is_agent: 'true' } });
    expect(planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed))).preview.blockers.map(b => b.code)).toContain('agent_node');

    const p = basicPair();
    const agentContact = makeContact({ id: uid(11), kgNodeId: A_ID, systemRole: 'agent', kind: 'agent' });
    const plan = planNodeMerge(makeSnapshot(makeSide(p.survivor), makeSide(p.absorbed, { contacts: [agentContact] })));
    expect(plan.preview.blockers.map(b => b.code)).toContain('agent_node');
  });

  it('blocks fact nodes', () => {
    const { survivor, absorbed } = basicPair({}, { type: 'fact' });
    expect(planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed))).preview.blockers.map(b => b.code)).toContain('fact_node');
  });
});

describe('planNodeMerge — suggestedDirection', () => {
  it('suggests a swap when a person with a contact would be absorbed by a contactless node of another type', () => {
    const { survivor, absorbed } = basicPair({ type: 'organization', label: 'Jane Doe Consulting' }, { type: 'person', label: 'Jane Doe' });
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor),
      makeSide(absorbed, { contacts: [makeContact({ id: uid(11), kgNodeId: A_ID })] }),
    ));
    expect(plan.preview.suggestedDirection.swap).toBe(true);
    expect(plan.preview.suggestedDirection.reason).toMatch(/personhood/);
  });

  it('does not suggest a swap for a plain same-type merge', () => {
    const { survivor, absorbed } = basicPair();
    expect(planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed))).preview.suggestedDirection).toEqual({ swap: false, reason: null });
  });
});

describe('planToken and determinism', () => {
  it('is stable for equal data regardless of key order and changes when data changes', () => {
    const a = basicPair({ properties: { a: 1, b: 2 } });
    const b = basicPair({ properties: { b: 2, a: 1 } });
    const snapA = makeSnapshot(makeSide(a.survivor), makeSide(a.absorbed));
    const snapB = makeSnapshot(makeSide(b.survivor), makeSide(b.absorbed));
    expect(planToken(snapA)).toBe(planToken(snapB));
    expect(planToken(snapA)).toMatch(/^[0-9a-f]{64}$/);

    const c = basicPair({ properties: { a: 1, b: 3 } });
    expect(planToken(makeSnapshot(makeSide(c.survivor), makeSide(c.absorbed)))).not.toBe(planToken(snapA));
  });

  it('yields identical plans (and conflict ids) for the same snapshot', () => {
    const { survivor, absorbed } = basicPair();
    const s = makeFact(uid(100), 'x', { attribute: 'title', value: 'CEO' });
    const a = makeFact(uid(101), 'y', { attribute: 'title', value: 'CTO' });
    const snap = makeSnapshot(makeSide(survivor, { facts: [s] }), makeSide(absorbed, { facts: [a] }));
    expect(canonicalJson(planNodeMerge(snap).preview)).toBe(canonicalJson(planNodeMerge(snap).preview));
    expect(planNodeMerge(snap).preview.planToken).toBe(planToken(snap));
  });

  it('summarizes each side for the preview header', () => {
    const { survivor, absorbed } = basicPair();
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor, { facts: [makeFact(uid(100), 'x')], edges: [makeEdge(uid(200), S_ID, uid(50))] }),
      makeSide(absorbed, { contacts: [makeContact({ id: uid(11), kgNodeId: A_ID, displayName: 'J', identities: [{ id: uid(30), channel: 'email', identifier: 'j@x.com', verified: true }] })] }),
    ));
    expect(plan.preview.survivor).toMatchObject({ id: S_ID, factCount: 1, edgeCount: 1, contacts: [] });
    expect(plan.preview.absorbed.contacts).toEqual([
      { id: uid(11), displayName: 'J', kind: 'person', systemRole: null, tier: 'known', identityCount: 1 },
    ]);
    expect(makeNode({ id: uid(1) }).type).toBe('person');
  });
});
