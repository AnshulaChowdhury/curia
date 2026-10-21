// Pure tests for applyResolutions / parseResolutions (spec §7 step 2, §12).
import { describe, it, expect } from 'vitest';
import { planNodeMerge } from '../../../src/kg-merge/planner.js';
import { applyResolutions, parseResolutions } from '../../../src/kg-merge/resolve.js';
import { InvalidResolutionError, MergeBlockedError } from '../../../src/kg-merge/errors.js';
import type { MergePlan } from '../../../src/kg-merge/types.js';
import {
  A_ID,
  S_ID,
  basicPair,
  makeContact,
  makeEdge,
  makeFact,
  makeSide,
  makeSnapshot,
  uid,
} from './fixtures.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';

function conflictPlan(): MergePlan {
  const { survivor, absorbed } = basicPair({ properties: { role: 'CEO' } }, { properties: { role: 'CTO' }, lastConfirmedAt: T2 });
  const sFact = makeFact(uid(100), 'Title: CEO', { attribute: 'title', value: 'CEO', previous_values: [{ value: 'VP' }] }, { lastConfirmedAt: T1, confidence: 0.6 });
  const aFact = makeFact(uid(101), 'Title: CTO', { attribute: 'title', value: 'CTO' }, { lastConfirmedAt: T2, confidence: 0.8, source: 'agent:x' });
  return planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [sFact] }), makeSide(absorbed, { facts: [aFact] })));
}

function expectInvalid(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidResolutionError);
    expect((err as InvalidResolutionError).code).toBe(code);
    return;
  }
  throw new Error('expected an InvalidResolutionError');
}

describe('applyResolutions — defaults', () => {
  it('fills every default and counts the conflicts resolved', () => {
    const plan = conflictPlan();
    const exec = applyResolutions(plan, {}, NOW);
    expect(exec.resolutions).toEqual({
      label: 'survivor',
      properties: { role: 'absorbed' },
      facts: { [`fact:${uid(100)}:${uid(101)}`]: 'absorbed' },
      nearDuplicateFacts: {},
      contactFields: {},
      authOverrides: {},
      acknowledgements: [],
    });
    expect(exec.summary.conflictsResolved).toBe(2);
    expect(exec.node.properties.role).toBe('CTO');
    expect(exec.node.labelChanged).toBe(false);
    expect(exec.mergedAt).toBe(NOW.toISOString());
  });

  it('honours an explicit choice over the default', () => {
    const exec = applyResolutions(conflictPlan(), { properties: { role: 'survivor' } }, NOW);
    expect(exec.node.properties.role).toBe('CEO');
  });
});

describe('applyResolutions — fact conflict choices and previous_values', () => {
  it('survivor: drops the absorbed fact and appends its value to the kept fact', () => {
    const plan = conflictPlan();
    const id = plan.facts.conflicts[0]!.id;
    const exec = applyResolutions(plan, { facts: { [id]: 'survivor' } }, NOW);
    expect(exec.facts.deleteFactIds).toEqual([uid(101)]);
    expect(exec.facts.relinkEdgeIds).toEqual([]);
    const update = exec.facts.updates.find(u => u.id === uid(100))!;
    expect(update.properties.previous_values).toEqual([
      { value: 'VP' },
      { value: 'CTO', label: 'Title: CTO', confidence: 0.8, source: 'agent:x', replaced_at: NOW.toISOString(), reason: 'node_merge' },
    ]);
  });

  it('absorbed: drops the survivor fact, moves the absorbed one and records the survivor value', () => {
    const plan = conflictPlan();
    const id = plan.facts.conflicts[0]!.id;
    const exec = applyResolutions(plan, { facts: { [id]: 'absorbed' } }, NOW);
    expect(exec.facts.deleteFactIds).toEqual([uid(100)]);
    expect(exec.facts.relinkEdgeIds).toEqual([`link-${uid(101)}`]);
    const update = exec.facts.updates.find(u => u.id === uid(101))!;
    expect(update.properties.previous_values).toEqual([
      expect.objectContaining({ value: 'CEO', reason: 'node_merge', replaced_at: NOW.toISOString() }),
    ]);
    expect(exec.summary.factsMoved).toBe(1);
  });

  it('both: keeps both facts and moves the absorbed one', () => {
    const plan = conflictPlan();
    const id = plan.facts.conflicts[0]!.id;
    const exec = applyResolutions(plan, { facts: { [id]: 'both' } }, NOW);
    expect(exec.facts.deleteFactIds).toEqual([]);
    expect(exec.facts.relinkEdgeIds).toEqual([`link-${uid(101)}`]);
    expect(exec.facts.updates).toEqual([]);
  });

  it('raises the kept fact’s sensitivity to the dropped fact’s, whose value it now holds', () => {
    const { survivor, absorbed } = basicPair();
    const sFact = makeFact(uid(100), 'Salary: 100k', { attribute: 'salary', value: '100k' }, { lastConfirmedAt: T1, sensitivity: 'internal' });
    const aFact = makeFact(uid(101), 'Salary: 120k', { attribute: 'salary', value: '120k' }, { lastConfirmedAt: T2, sensitivity: 'restricted' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [sFact] }), makeSide(absorbed, { facts: [aFact] })));
    const id = plan.facts.conflicts[0]!.id;

    const keepSurvivor = applyResolutions(plan, { facts: { [id]: 'survivor' } }, NOW);
    expect(keepSurvivor.facts.updates).toEqual([expect.objectContaining({ id: uid(100), sensitivity: 'restricted' })]);

    // Keeping the more sensitive fact never lowers it.
    const keepAbsorbed = applyResolutions(plan, { facts: { [id]: 'absorbed' } }, NOW);
    expect(keepAbsorbed.facts.updates).toEqual([expect.objectContaining({ id: uid(101), sensitivity: 'restricted' })]);
  });

  it('auto-collapses duplicates into the survivor fact with max confidence / confirmation / sensitivity', () => {
    const { survivor, absorbed } = basicPair();
    const s = makeFact(uid(100), 'Loves sailing', {}, { confidence: 0.5, lastConfirmedAt: T1, sensitivity: 'internal' });
    const a = makeFact(uid(101), 'loves sailing.', {}, { confidence: 0.9, lastConfirmedAt: T2, sensitivity: 'confidential' });
    const exec = applyResolutions(planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [s] }), makeSide(absorbed, { facts: [a] }))), {}, NOW);
    expect(exec.facts.deleteFactIds).toEqual([uid(101)]);
    expect(exec.facts.updates).toEqual([
      { id: uid(100), confidence: 0.9, lastConfirmedAt: T2, sensitivity: 'confidential', properties: {} },
    ]);
    expect(exec.summary.factsCollapsed).toBe(1);
  });
});

describe('applyResolutions — near-duplicates', () => {
  function nearPlan(sConf: number, aConf: number): MergePlan {
    const { survivor, absorbed } = basicPair();
    const s = makeFact(uid(100), 'Enjoys sailing', {}, { embedding: [1, 0], confidence: sConf });
    const a = makeFact(uid(101), 'Goes sailing', {}, { embedding: [0.999, 0.03], confidence: aConf });
    return planNodeMerge(makeSnapshot(makeSide(survivor, { facts: [s] }), makeSide(absorbed, { facts: [a] })));
  }

  it('merge (default) keeps the higher-confidence fact', () => {
    const exec = applyResolutions(nearPlan(0.4, 0.9), {}, NOW);
    expect(exec.facts.deleteFactIds).toEqual([uid(100)]);
    expect(exec.facts.relinkEdgeIds).toEqual([`link-${uid(101)}`]);
    expect(exec.facts.updates.map(u => u.id)).toEqual([uid(101)]);

    const tie = applyResolutions(nearPlan(0.7, 0.7), {}, NOW);
    expect(tie.facts.deleteFactIds).toEqual([uid(101)]);
  });

  it('keep_both moves the absorbed fact untouched', () => {
    const plan = nearPlan(0.4, 0.9);
    const exec = applyResolutions(plan, { nearDuplicateFacts: { [plan.facts.nearDuplicates[0]!.id]: 'keep_both' } }, NOW);
    expect(exec.facts.deleteFactIds).toEqual([]);
    expect(exec.facts.relinkEdgeIds).toEqual([`link-${uid(101)}`]);
  });
});

describe('applyResolutions — validation', () => {
  it('rejects ids the plan does not contain', () => {
    const plan = conflictPlan();
    expectInvalid(() => applyResolutions(plan, { facts: { 'fact:nope:nope': 'both' } }, NOW), 'unknown_resolution');
    expectInvalid(() => applyResolutions(plan, { properties: { missing: 'survivor' } }, NOW), 'unknown_resolution');
    expectInvalid(() => applyResolutions(plan, { contactFields: { title: 'absorbed' } }, NOW), 'unknown_resolution');
    expectInvalid(() => applyResolutions(plan, { authOverrides: { send_email: 'absorbed' } }, NOW), 'unknown_resolution');
    expectInvalid(() => applyResolutions(plan, { nearDuplicateFacts: { 'near:a:b': 'merge' } }, NOW), 'unknown_resolution');
  });

  it('requires every requiresAck warning to be acknowledged', () => {
    const { survivor, absorbed } = basicPair();
    const principal = makeContact({ id: uid(10), kgNodeId: S_ID, systemRole: 'principal', kind: 'principal', tier: 'principal' });
    const dup = makeContact({ id: uid(11), kgNodeId: A_ID, identities: [{ id: uid(31), channel: 'sms', identifier: '+15550002', verified: false }] });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { contacts: [principal] }), makeSide(absorbed, { contacts: [dup] })));
    expectInvalid(() => applyResolutions(plan, {}, NOW), 'ack_required');
    const exec = applyResolutions(plan, { acknowledgements: ['principal_identity_transfer'] }, NOW);
    expect(exec.contacts.survivingIsPrincipal).toBe(true);
    // A structural survivor contact keeps its own display name and tier.
    expect(exec.contacts.mergedRow).toMatchObject({ displayName: 'Contact', tier: 'principal', kind: 'principal' });
  });

  it('throws MergeBlockedError when the plan has blockers', () => {
    const { survivor, absorbed } = basicPair({}, { type: 'fact' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed)));
    expect(() => applyResolutions(plan, {}, NOW)).toThrow(MergeBlockedError);
  });

  it('blocks choosing an absorbed label that collides with a third node', () => {
    const { survivor, absorbed } = basicPair({ type: 'organization', label: 'Acme Inc' }, { type: 'event', label: 'Acme' });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed), uid(99)));
    expect(() => applyResolutions(plan, {}, NOW)).not.toThrow();
    try {
      applyResolutions(plan, { label: 'absorbed' }, NOW);
      throw new Error('expected MergeBlockedError');
    } catch (err) {
      expect(err).toBeInstanceOf(MergeBlockedError);
      expect((err as MergeBlockedError).blockers[0]!.code).toBe('label_collision');
    }
  });
});

describe('applyResolutions — node, edges and contacts', () => {
  it('applies the absorbed label, moving the survivor label into the aliases', () => {
    const { survivor, absorbed } = basicPair();
    const exec = applyResolutions(planNodeMerge(makeSnapshot(makeSide(survivor), makeSide(absorbed))), { label: 'absorbed' }, NOW);
    expect(exec.node).toMatchObject({ label: 'J. Doe', labelChanged: true, aliases: ['jane doe'] });
  });

  it('orders edge deletes before moves and merges collapsed edge attributes', () => {
    const { survivor, absorbed } = basicPair();
    const X = uid(50);
    const twin = makeEdge(uid(202), S_ID, X, 'works_on', { confidence: 0.5, properties: { since: 2020 }, decayClass: 'fast_decay', lastConfirmedAt: T1 });
    const collide = makeEdge(uid(201), A_ID, X, 'works_on', { confidence: 0.9, properties: { since: 2019, role: 'lead' }, decayClass: 'permanent', lastConfirmedAt: T2 });
    const loop = makeEdge(uid(200), S_ID, A_ID, 'relates_to');
    const move = makeEdge(uid(203), uid(51), A_ID, 'advises');
    const exec = applyResolutions(planNodeMerge(makeSnapshot(
      makeSide(survivor, { edges: [twin, loop] }),
      makeSide(absorbed, { edges: [loop, collide, move] }),
    )), {}, NOW);
    expect(exec.edges.deleteEdgeIds).toEqual([uid(200), uid(201)]);
    expect(exec.edges.moveEdgeIds).toEqual([uid(203)]);
    expect(exec.edges.collapses).toEqual([{
      survivorEdgeId: uid(202),
      absorbedEdgeId: uid(201),
      confidence: 0.9,
      lastConfirmedAt: T2,
      decayClass: 'permanent',
      properties: { since: 2020, role: 'lead' },
    }]);
  });

  it('builds the folded contact row: label as name, notes joined, tier, counters, chosen fields, override winners', () => {
    const { survivor, absorbed } = basicPair();
    const cs = makeContact({
      id: uid(10), kgNodeId: S_ID, displayName: 'Jane Doe', notes: 'met at summit', tier: 'known',
      contactConfidence: 0.4, lastSeenAt: T1, inboundMessageCount: 2, outboundMessageCount: 1,
      fields: { title: 'CEO' },
      authOverrides: [{ permission: 'send_email', granted: true }],
    });
    const ca = makeContact({
      id: uid(11), kgNodeId: A_ID, displayName: 'J. Doe', notes: 'prefers email', tier: 'trusted',
      contactConfidence: 0.9, lastSeenAt: T2, inboundMessageCount: 5, outboundMessageCount: 3,
      fields: { title: 'CTO', location: 'Paris' },
      authOverrides: [{ permission: 'send_email', granted: false }],
    });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { contacts: [cs] }), makeSide(absorbed, { contacts: [ca] })));
    const exec = applyResolutions(plan, {
      label: 'absorbed',
      contactFields: { title: 'absorbed' },
      authOverrides: { send_email: 'absorbed' },
    }, NOW);
    expect(exec.contacts).toMatchObject({
      action: 'merge',
      survivingContactId: uid(10),
      repoints: [],
      merges: [{ secondaryId: uid(11), overridesPreferSecondary: ['send_email'] }],
      mergedContactIds: [uid(11)],
    });
    expect(exec.contacts.mergedRow).toMatchObject({
      kgNodeId: S_ID,
      displayName: 'J. Doe',
      notes: 'met at summit\n---\nprefers email',
      tier: 'trusted',
      kind: 'person',
      title: 'CTO',
      location: 'Paris',
      contactConfidence: 0.9,
      lastSeenAt: new Date(T2),
      inboundMessageCount: 7,
      outboundMessageCount: 4,
    });
    expect(exec.summary.conflictsResolved).toBe(2);
  });

  it('prefers the denying contact at its fold when folded contacts disagree and the survivor holds nothing', () => {
    const { survivor, absorbed } = basicPair();
    const cs = makeContact({ id: uid(10), kgNodeId: S_ID });
    const granting = makeContact({ id: uid(11), kgNodeId: A_ID, createdAt: T1, authOverrides: [{ permission: 'calendar.write', granted: true }] });
    const denying = makeContact({ id: uid(12), kgNodeId: A_ID, createdAt: T2, authOverrides: [{ permission: 'calendar.write', granted: false }] });
    const plan = planNodeMerge(makeSnapshot(makeSide(survivor, { contacts: [cs] }), makeSide(absorbed, { contacts: [granting, denying] })));
    const exec = applyResolutions(plan, {}, NOW);
    expect(exec.contacts.merges).toEqual([
      { secondaryId: uid(11), overridesPreferSecondary: [] },
      { secondaryId: uid(12), overridesPreferSecondary: ['calendar.write'] },
    ]);
  });

  it('keeps blocked on either side', () => {
    const { survivor, absorbed } = basicPair();
    const plan = planNodeMerge(makeSnapshot(
      makeSide(survivor, { contacts: [makeContact({ id: uid(10), kgNodeId: S_ID, tier: 'trusted' })] }),
      makeSide(absorbed, { contacts: [makeContact({ id: uid(11), kgNodeId: A_ID, tier: 'blocked' })] }),
    ));
    expect(applyResolutions(plan, {}, NOW).contacts.mergedRow!.tier).toBe('blocked');
  });
});

describe('parseResolutions', () => {
  it('accepts a well-formed body and treats null/undefined as empty', () => {
    expect(parseResolutions(undefined)).toEqual({});
    expect(parseResolutions(null)).toEqual({});
    expect(parseResolutions({
      label: 'absorbed',
      properties: { a: 'survivor' },
      facts: { f: 'both' },
      nearDuplicateFacts: { n: 'keep_both' },
      contactFields: { title: 'absorbed' },
      authOverrides: { p: 'survivor' },
      acknowledgements: ['principal_identity_transfer'],
    })).toEqual({
      label: 'absorbed',
      properties: { a: 'survivor' },
      facts: { f: 'both' },
      nearDuplicateFacts: { n: 'keep_both' },
      contactFields: { title: 'absorbed' },
      authOverrides: { p: 'survivor' },
      acknowledgements: ['principal_identity_transfer'],
    });
  });

  it('rejects malformed shapes with invalid_request', () => {
    expectInvalid(() => parseResolutions('x'), 'invalid_request');
    expectInvalid(() => parseResolutions({ label: 'other' }), 'invalid_request');
    expectInvalid(() => parseResolutions({ properties: ['survivor'] }), 'invalid_request');
    expectInvalid(() => parseResolutions({ facts: { f: 'merge' } }), 'invalid_request');
    expectInvalid(() => parseResolutions({ nearDuplicateFacts: { n: 'both' } }), 'invalid_request');
    expectInvalid(() => parseResolutions({ acknowledgements: [1] }), 'invalid_request');
  });
});
