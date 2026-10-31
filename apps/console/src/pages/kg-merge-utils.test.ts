import { describe, it, expect } from 'vitest';
import {
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  LABEL_COLLISION_MESSAGE,
  MERGE_UNAVAILABLE_MESSAGE,
  STALE_PREVIEW_NOTICE,
  applyButtonLabel,
  applyHint,
  applyMergeToNodeList,
  buildApplyRequest,
  buildPreviewRequest,
  canApply,
  candidateReasonLabel,
  cardFor,
  cardFromSummary,
  classifyApplyError,
  classifyMergeError,
  conflictCount,
  contactPlanSentence,
  crossTypeBanner,
  defaultResolutions,
  displayAliases,
  filterCandidates,
  filterSearchResults,
  formatConfidence,
  formatDay,
  formatValue,
  hasContactSection,
  hasLabelCollision,
  isAgentNode,
  isLabelAllowed,
  isLabelCollisionBlock,
  isNodeMergePreview,
  isNodeMergeResult,
  isPickable,
  isRetryable,
  labelCollisionReason,
  labelsDiffer,
  mergeAvailability,
  mergeResolutions,
  mergeResultNotes,
  mergeResultWarningText,
  mergeSuccessMessage,
  mergedIntoFrom,
  mergedIntoNotice,
  missingAcknowledgements,
  outcomeUnknownError,
  plural,
  resultAliases,
  retainAcknowledgements,
  retainValidChoices,
  searchUrl,
  suggestionText,
  summaryLines,
  swapConflictId,
  swapResolutions,
  toggleAcknowledgement,
  typeLabel,
} from './kg-merge-utils.js';
import type { ApiKgNode } from './kg-types.js';
import type {
  MergeCandidate,
  MergeFactSummary,
  MergeNodeSummary,
  NodeMergePreview,
} from './kg-merge-types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const S = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';

function node(over: Partial<ApiKgNode> = {}): ApiKgNode {
  return {
    id: S, label: 'Acme', type: 'organization', confidence: 0.8, decayClass: 'permanent',
    sensitivity: 'internal', properties: {}, source: 'test', createdAt: '2026-01-01T00:00:00Z',
    lastConfirmedAt: '2026-10-01T00:00:00Z', ...over,
  };
}

function summary(over: Partial<MergeNodeSummary> = {}): MergeNodeSummary {
  return {
    id: S, label: 'Acme', type: 'organization', aliases: [], identitySource: 'label',
    sensitivity: 'internal', confidence: 0.8, decayClass: 'permanent',
    lastConfirmedAt: '2026-10-01T00:00:00Z', factCount: 3, edgeCount: 2, contacts: [], ...over,
  };
}

function fact(id: string, over: Partial<MergeFactSummary> = {}): MergeFactSummary {
  return {
    id, label: `fact ${id}`, attribute: null, value: null, confidence: 0.7,
    lastConfirmedAt: '2026-09-01T00:00:00Z', source: 'test', sensitivity: 'internal', ...over,
  };
}

function preview(over: Partial<NodeMergePreview> = {}): NodeMergePreview {
  return {
    dryRun: true,
    planToken: 'tok-1',
    survivor: summary(),
    absorbed: summary({ id: A, label: 'Acme Summit', type: 'event', aliases: ['acme summit 2026'] }),
    crossType: true,
    suggestedDirection: { swap: false, reason: null },
    result: {
      type: 'organization',
      labels: { survivor: 'Acme', absorbed: 'Acme Summit' },
      defaultLabel: 'survivor',
      aliases: ['acme summit', 'acme summit 2026'],
      droppedAliases: [],
      aliasOptions: {
        survivor: { aliases: ['acme summit', 'acme summit 2026'], droppedAliases: [] },
        absorbed: { aliases: ['acme', 'acme summit 2026'], droppedAliases: [] },
      },
      sensitivity: 'internal', confidence: 0.8, decayClass: 'permanent', identitySource: 'label',
    },
    blockers: [],
    warnings: [],
    conflicts: { properties: [], facts: [], nearDuplicateFacts: [], contactFields: [], authOverrides: [] },
    contactPlan: {
      action: 'none', survivingContactId: null, mergedContactIds: [], repointedContactIds: [],
      resultingKind: null, identities: [],
    },
    summary: { factsMoved: 0, factsCollapsed: 0, edgesMoved: 0, edgesCollapsed: 0, edgesDropped: 0 },
    ...over,
  };
}

/** A preview with one conflict of every kind. */
function conflicted(): NodeMergePreview {
  return preview({
    conflicts: {
      properties: [{ key: 'website', survivorValue: 'acme.com', absorbedValue: 'acme.io', default: 'absorbed' }],
      facts: [{
        id: 'fact:f1:f2', attribute: 'title',
        survivor: fact('f1', { attribute: 'title', value: 'CEO' }),
        absorbed: fact('f2', { attribute: 'title', value: 'CTO' }),
        default: 'survivor',
      }],
      nearDuplicateFacts: [{
        id: 'near:f3:f4', survivor: fact('f3'), absorbed: fact('f4'), similarity: 0.95, default: 'merge',
      }],
      contactFields: [{ field: 'timezone', label: 'Timezone', survivorValue: 'UTC', absorbedValue: 'EST', default: 'survivor' }],
      authOverrides: [{ permission: 'calendar.write', survivorGranted: true, absorbedGranted: false, default: 'survivor' }],
    },
  });
}

// ── Formatting ──────────────────────────────────────────────────────────────

describe('formatting helpers', () => {
  it('pluralises', () => {
    expect(plural(1, 'fact')).toBe('1 fact');
    expect(plural(0, 'fact')).toBe('0 facts');
    expect(plural(2, 'identity', 'identities')).toBe('2 identities');
  });

  it('labels types', () => {
    expect(typeLabel('organization')).toBe('Organization');
    expect(typeLabel('slow_decay')).toBe('Slow decay');
    expect(typeLabel('')).toBe('Unknown');
  });

  it('formats values: strings verbatim, the rest as JSON', () => {
    expect(formatValue('acme.com')).toBe('acme.com');
    expect(formatValue('')).toBe('(empty)');
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(false)).toBe('false');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue(['x', 'y'])).toBe('["x","y"]');
  });

  it('survives values JSON cannot encode', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(formatValue(circular)).toBe('[object Object]');
    expect(formatValue(10n)).toBe('10');
  });

  it('formats confidence and days', () => {
    expect(formatConfidence(0.8)).toBe('0.80');
    expect(formatConfidence(undefined)).toBe('—');
    expect(formatConfidence(Number.NaN)).toBe('—');
    expect(formatDay('2026-10-21T15:00:00Z')).toBe('2026-10-21');
    expect(formatDay('nope')).toBe('—');
    expect(formatDay('')).toBe('—');
  });

  it('maps candidate reasons to chips', () => {
    expect(candidateReasonLabel('same_label')).toBe('Same name');
    expect(candidateReasonLabel('alias_match')).toBe('Alias');
    expect(candidateReasonLabel('similar_embedding')).toBe('Similar');
    expect(candidateReasonLabel('something_new')).toBe('something_new');
  });
});

// ── Entry point ─────────────────────────────────────────────────────────────

describe('mergeAvailability', () => {
  it('hides the button for fact nodes', () => {
    expect(mergeAvailability(node({ type: 'fact' })).visible).toBe(false);
  });

  it('disables it for the agent node, with a reason', () => {
    for (const flag of ['true', true]) {
      const a = mergeAvailability(node({ type: 'person', properties: { is_agent: flag } }));
      expect(a).toMatchObject({ visible: true, disabled: true });
      expect(a.reason).toMatch(/agent/i);
    }
  });

  it('disables it for an archived node, with a reason', () => {
    const a = mergeAvailability(node({ archived: true }));
    expect(a).toMatchObject({ visible: true, disabled: true });
    expect(a.reason).toMatch(/archived/i);
    expect(mergeAvailability(node({ archived: false })).disabled).toBe(false);
  });

  it('enables it otherwise', () => {
    expect(mergeAvailability(node({ properties: { is_agent: 'false' } }))).toEqual({ visible: true, disabled: false, reason: null });
    expect(isAgentNode(node({ properties: {} }))).toBe(false);
  });
});

// ── Pick step ───────────────────────────────────────────────────────────────

describe('pick step', () => {
  it('shows up to three aliases and counts the rest', () => {
    expect(displayAliases(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
    expect(displayAliases(undefined)).toEqual({ shown: [], more: 0 });
    expect(displayAliases(['a', ' ', 'b'])).toEqual({ shown: ['a', 'b'], more: 0 });
  });

  it('filters search results: no self, no facts, no duplicates', () => {
    const results = filterSearchResults([
      node({ id: S }), node({ id: A }), node({ id: 'f', type: 'fact' }), node({ id: A }), node({ id: 'x' }),
    ], S);
    expect(results.map(n => n.id)).toEqual([A, 'x']);
  });

  it('never offers an archived node', () => {
    expect(isPickable(node({ id: A, archived: true }), S)).toBe(false);
    expect(isPickable(node({ id: A }), S)).toBe(true);
    expect(filterSearchResults([node({ id: A, archived: true }), node({ id: 'x' })], S).map(n => n.id)).toEqual(['x']);
  });

  it('asks the server to leave facts out of search results', () => {
    expect(searchUrl('Acme & co')).toBe('/api/kg/nodes?query=Acme%20%26%20co&limit=20&exclude_facts=true');
  });

  it('filters and sorts candidates by score', () => {
    const c = (id: string, score: number, type = 'organization'): MergeCandidate =>
      ({ node: node({ id, type }), score, reasons: ['similar_embedding'] });
    const out = filterCandidates([c('x', 0.81), c(S, 1), c('y', 1), c('f', 0.99, 'fact'), c('x', 0.9)], S);
    expect(out.map(o => [o.node.id, o.score])).toEqual([['y', 1], ['x', 0.81]]);
  });
});

// ── Cards and banners ───────────────────────────────────────────────────────

describe('cards', () => {
  it('summarises a node with stats and contacts', () => {
    const card = cardFromSummary(summary({
      factCount: 1, edgeCount: 4,
      contacts: [
        { id: 'c1', displayName: 'Jane Doe', kind: 'person', systemRole: 'principal', tier: 'trusted', identityCount: 2 },
        { id: 'c2', displayName: 'Acme Inc', kind: 'organization', systemRole: null, tier: 'unknown', identityCount: 1 },
        { id: 'c3', displayName: 'Bob', kind: 'person', systemRole: null, tier: 'unknown', identityCount: 1 },
      ],
    }));
    expect(card.stats).toBe('1 fact · 4 connections');
    expect(card.contacts).toEqual(['Jane Doe · principal', 'Acme Inc · organization', 'Bob']);
  });

  it('prefers preview summaries and falls back to known nodes', () => {
    const p = preview();
    expect(cardFor(S, p, [])?.stats).toBe('3 facts · 2 connections');
    expect(cardFor(A, p, [])?.label).toBe('Acme Summit');
    const loose = node({ id: 'z', label: 'Zed', aliases: ['zee'] });
    expect(cardFor('z', p, [loose])).toMatchObject({ label: 'Zed', stats: null, aliases: ['zee'] });
    expect(cardFor('z', null, [loose])?.label).toBe('Zed');
    expect(cardFor('missing', null, [])).toBeNull();
  });
});

describe('banners', () => {
  it('describes a cross-type merge', () => {
    expect(crossTypeBanner(preview())).toBe(
      '‘Acme Summit’ (Event) will become part of ‘Acme’ (Organization). The result is an Organization.');
    expect(crossTypeBanner(preview({ crossType: false }))).toBeNull();
  });

  it('uses "a" before consonants', () => {
    const p = preview({ result: { ...preview().result, type: 'person' } });
    expect(crossTypeBanner(p)).toMatch(/The result is a Person\.$/);
  });

  it('suggests swapping when the server says so', () => {
    expect(suggestionText(preview())).toBeNull();
    expect(suggestionText(preview({ suggestedDirection: { swap: true, reason: 'it would lose personhood' } })))
      .toBe('Suggested: keep ‘Acme Summit’ instead — it would lose personhood');
    expect(suggestionText(preview({ suggestedDirection: { swap: true, reason: null } })))
      .toBe('Suggested: keep ‘Acme Summit’ instead.');
  });
});

// ── Resolutions ─────────────────────────────────────────────────────────────

describe('defaultResolutions', () => {
  it('takes every default from the preview', () => {
    expect(defaultResolutions(conflicted())).toEqual({
      label: 'survivor',
      properties: { website: 'absorbed' },
      facts: { 'fact:f1:f2': 'survivor' },
      nearDuplicateFacts: { 'near:f3:f4': 'merge' },
      contactFields: { timezone: 'survivor' },
      authOverrides: { 'calendar.write': 'survivor' },
    });
  });

  it('is empty-mapped for a conflict-free preview', () => {
    expect(defaultResolutions(preview())).toEqual({
      label: 'survivor', properties: {}, facts: {}, nearDuplicateFacts: {}, contactFields: {}, authOverrides: {},
    });
  });
});

describe('retainValidChoices / mergeResolutions', () => {
  it('keeps choices whose ids still exist and drops the rest', () => {
    const prev = {
      label: 'absorbed' as const,
      properties: { website: 'survivor' as const, gone: 'absorbed' as const },
      facts: { 'fact:f1:f2': 'both' as const, 'fact:old:old': 'absorbed' as const },
      nearDuplicateFacts: { 'near:f3:f4': 'keep_both' as const },
      contactFields: { timezone: 'absorbed' as const },
      authOverrides: { 'calendar.write': 'absorbed' as const, other: 'survivor' as const },
    };
    expect(retainValidChoices(prev, conflicted())).toEqual({
      label: 'absorbed',
      properties: { website: 'survivor' },
      facts: { 'fact:f1:f2': 'both' },
      nearDuplicateFacts: { 'near:f3:f4': 'keep_both' },
      contactFields: { timezone: 'absorbed' },
      authOverrides: { 'calendar.write': 'absorbed' },
    });
  });

  it('rejects illegal values for a still-valid id', () => {
    const prev = {
      properties: { website: 'both' },
      nearDuplicateFacts: { 'near:f3:f4': 'survivor' },
    } as unknown as Parameters<typeof retainValidChoices>[0];
    const kept = retainValidChoices(prev, conflicted());
    expect(kept.properties).toEqual({});
    expect(kept.nearDuplicateFacts).toEqual({});
  });

  it('drops the label choice once the labels no longer differ', () => {
    const same = preview({ result: { ...preview().result, labels: { survivor: 'Acme', absorbed: 'Acme' } } });
    expect(labelsDiffer(same)).toBe(false);
    expect(retainValidChoices({ label: 'absorbed' }, same).label).toBeUndefined();
  });

  it('overlays valid choices on the new defaults', () => {
    const merged = mergeResolutions({ properties: { website: 'survivor', gone: 'absorbed' } }, conflicted());
    expect(merged.properties).toEqual({ website: 'survivor' });
    expect(merged.facts).toEqual({ 'fact:f1:f2': 'survivor' });
    expect(merged.label).toBe('survivor');
  });

  it('picks up new conflicts that appeared on re-preview, at their defaults', () => {
    const next = conflicted();
    next.conflicts.properties.push({ key: 'hq', survivorValue: 'NYC', absorbedValue: 'SF', default: 'survivor' });
    expect(mergeResolutions({ properties: { website: 'survivor' } }, next).properties)
      .toEqual({ website: 'survivor', hq: 'survivor' });
  });
});

// ── Label collision ─────────────────────────────────────────────────────────

const collision = {
  code: 'label_collision', message: '‘Acme Summit’ cannot be the name: another organization node already uses it.',
  requiresAck: false, details: ['Acme Summit (organization)'],
};

describe('label collision', () => {
  const collided = (over: Partial<NodeMergePreview['result']> = {}) =>
    preview({ warnings: [collision], result: { ...preview().result, ...over } });

  it('disallows only the absorbed label, and explains why', () => {
    const p = collided();
    expect(hasLabelCollision(p)).toBe(true);
    expect(isLabelAllowed(p, 'survivor')).toBe(true);
    expect(isLabelAllowed(p, 'absorbed')).toBe(false);
    expect(labelCollisionReason(p)).toBe('Another organization is already called ‘Acme Summit’.');
    expect(labelCollisionReason(preview())).toBeNull();
    expect(isLabelAllowed(preview(), 'absorbed')).toBe(true);
  });

  it('never defaults to the disallowed label', () => {
    expect(defaultResolutions(collided({ defaultLabel: 'absorbed' })).label).toBe('survivor');
    expect(defaultResolutions(preview({ result: { ...preview().result, defaultLabel: 'absorbed' } })).label)
      .toBe('absorbed');
  });

  it('drops an earlier absorbed-label choice on re-preview', () => {
    expect(retainValidChoices({ label: 'absorbed' }, collided()).label).toBeUndefined();
    expect(retainValidChoices({ label: 'survivor' }, collided()).label).toBe('survivor');
    expect(mergeResolutions({ label: 'absorbed' }, collided()).label).toBe('survivor');
  });

  it('drops it after a swap lands on the colliding label', () => {
    // The user kept the survivor's name; swapping turns that into "absorbed",
    // which the swapped preview disallows.
    const choices = swapResolutions({ label: 'survivor' });
    expect(choices.label).toBe('absorbed');
    expect(mergeResolutions(choices, collided()).label).toBe('survivor');
  });

  it('never sends the disallowed label', () => {
    const p = collided({ defaultLabel: 'absorbed' });
    expect(buildApplyRequest(p, { label: 'absorbed' }, []).resolutions?.label).toBe('survivor');
  });

  it('looks up the aliases for the overridden label from the server options', () => {
    const p = collided({ defaultLabel: 'absorbed', aliases: ['server'], droppedAliases: [] });
    const label = mergeResolutions({}, p).label!;
    expect(resultAliases(p, label).aliases).toEqual(['acme summit', 'acme summit 2026']);
  });
});

describe('swapResolutions', () => {
  it('reverses direction-embedding ids', () => {
    expect(swapConflictId('fact:a:b')).toBe('fact:b:a');
    expect(swapConflictId('near:a:b')).toBe('near:b:a');
    expect(swapConflictId('website')).toBe('website');
  });

  it('flips sides so the chosen value stays chosen', () => {
    expect(swapResolutions({
      label: 'absorbed',
      properties: { website: 'absorbed' },
      facts: { 'fact:f1:f2': 'survivor', 'fact:f5:f6': 'both' },
      nearDuplicateFacts: { 'near:f3:f4': 'keep_both' },
      contactFields: { timezone: 'survivor' },
      authOverrides: { 'calendar.write': 'absorbed' },
      acknowledgements: ['principal_identity_transfer'],
    })).toEqual({
      label: 'survivor',
      properties: { website: 'survivor' },
      facts: { 'fact:f2:f1': 'absorbed', 'fact:f6:f5': 'both' },
      nearDuplicateFacts: { 'near:f4:f3': 'keep_both' },
      contactFields: { timezone: 'absorbed' },
      authOverrides: { 'calendar.write': 'survivor' },
    });
  });

  it('is an involution on choices', () => {
    const c = { label: 'absorbed' as const, facts: { 'fact:x:y': 'absorbed' as const } };
    expect(swapResolutions(swapResolutions(c))).toEqual(c);
    expect(swapResolutions({})).toEqual({});
  });

  it('round-trips through a swapped preview', () => {
    // After a swap the server reports the conflict under the reversed id.
    const swapped = conflicted();
    swapped.conflicts.facts[0]!.id = 'fact:f2:f1';
    const choices = swapResolutions({ facts: { 'fact:f1:f2': 'absorbed' } });
    expect(mergeResolutions(choices, swapped).facts).toEqual({ 'fact:f2:f1': 'survivor' });
  });
});

describe('conflictCount', () => {
  it('counts every conflict array', () => {
    expect(conflictCount(conflicted())).toBe(5);
    expect(conflictCount(preview())).toBe(0);
  });
});

// ── Acknowledgements and the gate ───────────────────────────────────────────

const transfer = {
  code: 'principal_identity_transfer', message: 'These identities become principal identities',
  requiresAck: true, details: ['email: j@x.com'],
};
const info = { code: 'org_contacts_repointed', message: '2 contacts now link here', requiresAck: false };

describe('acknowledgements', () => {
  it('lists unacknowledged requires-ack warnings once each', () => {
    const p = preview({ warnings: [transfer, info, transfer] });
    expect(missingAcknowledgements(p, [])).toEqual(['principal_identity_transfer']);
    expect(missingAcknowledgements(p, ['principal_identity_transfer'])).toEqual([]);
  });

  it('gates Merge on blockers and acks', () => {
    const p = preview({ warnings: [transfer] });
    expect(canApply(p, [])).toBe(false);
    expect(applyHint(p, [])).toBe('Confirm 1 warning to continue');
    expect(canApply(p, ['principal_identity_transfer'])).toBe(true);
    expect(applyHint(p, ['principal_identity_transfer'])).toBeNull();

    const blocked = preview({ blockers: [{ code: 'agent_node', message: 'The agent node cannot be merged' }] });
    expect(canApply(blocked, [])).toBe(false);
    expect(applyHint(blocked, [])).toBe('Blocked — see the issue above');
    const twice = preview({ blockers: [{ code: 'a', message: 'a' }, { code: 'b', message: 'b' }] });
    expect(applyHint(twice, [])).toBe('Blocked — see the issues above');
  });

  it('non-ack warnings never gate', () => {
    expect(canApply(preview({ warnings: [info] }), [])).toBe(true);
  });

  it('keeps an ack across a re-preview only when the warning is unchanged', () => {
    const before = preview({ warnings: [transfer] });
    expect(retainAcknowledgements(['principal_identity_transfer'], before, preview({ warnings: [transfer] })))
      .toEqual(['principal_identity_transfer']);
    const grown = preview({ warnings: [{ ...transfer, details: ['email: j@x.com', 'signal: +1555'] }] });
    expect(retainAcknowledgements(['principal_identity_transfer'], before, grown)).toEqual([]);
    expect(retainAcknowledgements(['principal_identity_transfer'], before, preview())).toEqual([]);
  });

  it('toggles an ack without duplicating it', () => {
    expect(toggleAcknowledgement([], 'x', true)).toEqual(['x']);
    expect(toggleAcknowledgement(['x'], 'x', true)).toEqual(['x']);
    expect(toggleAcknowledgement(['x', 'y'], 'x', false)).toEqual(['y']);
  });
});

// ── Requests ────────────────────────────────────────────────────────────────

describe('requests', () => {
  it('builds a dry-run preview request', () => {
    expect(buildPreviewRequest(S, A)).toEqual({ survivorId: S, absorbedId: A, dryRun: true });
  });

  it('builds an apply request with explicit answers and the plan token', () => {
    const p = preview({ ...conflicted(), warnings: [transfer, info] });
    const req = buildApplyRequest(p, { facts: { 'fact:f1:f2': 'both' }, properties: { stale: 'survivor' } },
      ['principal_identity_transfer', 'org_contacts_repointed', 'unknown', 'principal_identity_transfer']);
    expect(req).toEqual({
      survivorId: S,
      absorbedId: A,
      dryRun: false,
      planToken: 'tok-1',
      resolutions: {
        label: 'survivor',
        properties: { website: 'absorbed' },
        facts: { 'fact:f1:f2': 'both' },
        nearDuplicateFacts: { 'near:f3:f4': 'merge' },
        contactFields: { timezone: 'survivor' },
        authOverrides: { 'calendar.write': 'survivor' },
        acknowledgements: ['principal_identity_transfer'],
      },
    });
  });

  it('omits empty sections', () => {
    const req = buildApplyRequest(preview(), {}, []);
    expect(req.resolutions).toEqual({ label: 'survivor' });
  });
});

// ── Aliases ─────────────────────────────────────────────────────────────────

describe('resultAliases', () => {
  const withOptions = () => preview({
    result: {
      ...preview().result,
      aliases: ['default'],
      droppedAliases: ['default-dropped'],
      aliasOptions: {
        survivor: { aliases: ['s1', 's2'], droppedAliases: ['s-dropped'] },
        absorbed: { aliases: ['a1'], droppedAliases: [] },
      },
    },
  });

  it('looks up the server-computed aliases for each label choice', () => {
    expect(resultAliases(withOptions(), 'survivor')).toEqual({ aliases: ['s1', 's2'], dropped: ['s-dropped'] });
    expect(resultAliases(withOptions(), 'absorbed')).toEqual({ aliases: ['a1'], dropped: [] });
  });

  it('does not fall back to result.aliases for the default label', () => {
    expect(resultAliases(withOptions(), 'survivor').aliases).not.toEqual(['default']);
  });
});

// ── Contacts ────────────────────────────────────────────────────────────────

const jane = { id: 'c1', displayName: 'Jane Doe', kind: 'person', systemRole: null, tier: 'trusted', identityCount: 2 };
const jd = { id: 'c2', displayName: 'J. Doe', kind: 'person', systemRole: null, tier: 'unknown', identityCount: 1 };

describe('contactPlanSentence', () => {
  it('names the contacts that become one', () => {
    const p = preview({
      survivor: summary({ type: 'person', contacts: [jane] }),
      absorbed: summary({ id: A, type: 'person', contacts: [jd] }),
      contactPlan: {
        action: 'merge', survivingContactId: 'c1', mergedContactIds: ['c2'], repointedContactIds: [],
        resultingKind: 'person', identities: [],
      },
    });
    expect(contactPlanSentence(p)).toBe('‘Jane Doe’ and ‘J. Doe’ will become one contact.');
    expect(hasContactSection(p)).toBe(true);
  });

  it('mentions a kind change and joins three names', () => {
    const org = { ...jd, id: 'c3', displayName: 'Acme', kind: 'organization' };
    const p = preview({
      survivor: summary({ type: 'person', contacts: [jane] }),
      absorbed: summary({ id: A, contacts: [jd, org] }),
      contactPlan: {
        action: 'merge', survivingContactId: 'c1', mergedContactIds: ['c2', 'c3'], repointedContactIds: [],
        resultingKind: 'person', identities: [],
      },
    });
    expect(contactPlanSentence(p)).toBe('‘Jane Doe’, ‘J. Doe’ and ‘Acme’ will become one contact (kind: person).');
  });

  it('falls back to a count when names are unknown', () => {
    const p = preview({
      contactPlan: {
        action: 'merge', survivingContactId: 'x', mergedContactIds: ['y'], repointedContactIds: [],
        resultingKind: null, identities: [],
      },
    });
    expect(contactPlanSentence(p)).toBe('2 contacts will become one.');
  });

  it('describes re-pointing into an organization, with the Contacts-page hint', () => {
    const acmeContact = { ...jd, id: 'c9', displayName: 'Acme Corp', kind: 'organization' };
    const p = preview({
      survivor: summary({ contacts: [acmeContact] }),
      absorbed: summary({ id: A, type: 'person', contacts: [jd] }),
      contactPlan: {
        action: 'repoint', survivingContactId: null, mergedContactIds: [], repointedContactIds: ['c2'],
        resultingKind: 'organization', identities: [],
      },
    });
    expect(contactPlanSentence(p)).toBe(
      '‘J. Doe’ will now link to ‘Acme’ (kind: organization). Merge duplicate contacts on the Contacts page.');
  });

  it('describes a re-point into a person without the hint', () => {
    const p = preview({
      survivor: summary({ type: 'person', label: 'Jane' }),
      absorbed: summary({ id: A, type: 'person', contacts: [jd] }),
      contactPlan: {
        action: 'repoint', survivingContactId: 'c2', mergedContactIds: [], repointedContactIds: ['c2'],
        resultingKind: 'person', identities: [],
      },
    });
    expect(contactPlanSentence(p)).toBe('‘J. Doe’ will now link to ‘Jane’.');
  });

  it('is silent when nothing happens to contacts', () => {
    expect(contactPlanSentence(preview())).toBeNull();
    expect(hasContactSection(preview())).toBe(false);
    expect(hasContactSection(conflicted())).toBe(true);
  });
});

// ── Summary ─────────────────────────────────────────────────────────────────

describe('summaryLines', () => {
  it('builds the plain-language summary', () => {
    const p = preview({
      summary: { factsMoved: 12, factsCollapsed: 3, edgesMoved: 7, edgesCollapsed: 1, edgesDropped: 1 },
      result: { ...preview().result, sensitivity: 'confidential', confidence: 0.9, decayClass: 'permanent' },
      contactPlan: {
        action: 'merge', survivingContactId: 'c1', mergedContactIds: ['c2'], repointedContactIds: [],
        resultingKind: 'person', identities: [],
      },
    });
    expect(summaryLines(p)).toEqual([
      '12 facts move',
      '3 duplicate facts combined',
      '7 connections move',
      '1 duplicate connection combined',
      'the connection between these two is removed',
      'the result is an Organization',
      'sensitivity becomes confidential',
      'confidence rises to 0.90',
      '2 contacts become one',
      '‘Acme Summit’ is archived (not deleted) and points to the result',
    ]);
  });

  it('handles singulars, several dropped edges, decay and identity changes', () => {
    const p = preview({
      crossType: false,
      survivor: summary({ decayClass: 'fast_decay', identitySource: 'label' }),
      summary: { factsMoved: 1, factsCollapsed: 0, edgesMoved: 1, edgesCollapsed: 0, edgesDropped: 2 },
      result: { ...preview().result, decayClass: 'slow_decay', identitySource: 'contact' },
      contactPlan: {
        action: 'repoint', survivingContactId: null, mergedContactIds: [], repointedContactIds: ['c2'],
        resultingKind: 'organization', identities: [],
      },
    });
    expect(summaryLines(p)).toEqual([
      '1 fact moves',
      '1 connection moves',
      'the 2 connections between these two are removed',
      'decay class becomes slow decay',
      '1 contact relinked',
      'identity now follows the contact record',
      '‘Acme Summit’ is archived (not deleted) and points to the result',
    ]);
  });

  it('always says what happens to the absorbed node', () => {
    expect(summaryLines(preview({ crossType: false }))).toEqual([
      '‘Acme Summit’ is archived (not deleted) and points to the result',
    ]);
  });
});

describe('applyButtonLabel', () => {
  it('names the survivor and counts conflicts', () => {
    expect(applyButtonLabel(preview(), false)).toBe('Merge into ‘Acme’');
    expect(applyButtonLabel(conflicted(), false)).toBe('Merge into ‘Acme’ (5 conflicts reviewed)');
    expect(applyButtonLabel(conflicted(), true)).toBe('Merging…');
  });
});

// ── Responses and errors ────────────────────────────────────────────────────

describe('response guards', () => {
  it('recognises a preview', () => {
    expect(isNodeMergePreview(preview())).toBe(true);
    expect(isNodeMergePreview({ ...preview(), dryRun: false })).toBe(false);
    expect(isNodeMergePreview({ ...preview(), conflicts: { properties: [] } })).toBe(false);
    expect(isNodeMergePreview(null)).toBe(false);
  });

  it('rejects a preview without the per-label alias options', () => {
    const rest: Record<string, unknown> = { ...preview().result };
    delete rest['aliasOptions'];
    expect(isNodeMergePreview({ ...preview(), result: rest })).toBe(false);
    const half = { ...preview().result, aliasOptions: { survivor: { aliases: [], droppedAliases: [] } } };
    expect(isNodeMergePreview({ ...preview(), result: half })).toBe(false);
  });

  it('recognises a result', () => {
    expect(isNodeMergeResult({ dryRun: false, survivorId: S, absorbedId: A, node: node() })).toBe(true);
    expect(isNodeMergeResult({ dryRun: true, survivorId: S, absorbedId: A, node: node() })).toBe(false);
    expect(isNodeMergeResult('nope')).toBe(false);
  });
});

describe('classifyMergeError', () => {
  it('maps 409 to a stale preview', () => {
    expect(classifyMergeError(409, { error: 'x', code: 'stale_preview' }))
      .toMatchObject({ kind: 'stale', code: 'stale_preview', message: STALE_PREVIEW_NOTICE });
  });

  it('maps 422 to blocked, keeping well-formed blockers', () => {
    const e = classifyMergeError(422, {
      error: 'Merge is blocked', code: 'blocked',
      blockers: [{ code: 'agent_node', message: 'Agent node' }, { code: 7 }, 'junk'],
    });
    expect(e).toEqual({
      kind: 'blocked', code: 'blocked', message: 'Merge is blocked',
      blockers: [{ code: 'agent_node', message: 'Agent node' }],
    });
  });

  it('maps 400s, preferring the server message', () => {
    expect(classifyMergeError(400, { error: 'Missing ack', code: 'ack_required' }))
      .toMatchObject({ kind: 'invalid', code: 'ack_required', message: 'Missing ack' });
    expect(classifyMergeError(400, { code: 'ack_required' }).message).toMatch(/confirm every warning/);
    expect(classifyMergeError(400, {}).message).toBe('The merge request was rejected.');
  });

  it('turns a name-only 422 into a pick-the-other-name message', () => {
    const e = classifyMergeError(422, {
      error: 'Merge is blocked', code: 'blocked',
      blockers: [{ code: 'label_collision', message: '‘X’ cannot be the name' }],
    });
    expect(e).toMatchObject({ kind: 'blocked', message: LABEL_COLLISION_MESSAGE });
    expect(e.message).not.toMatch(/go back/i);
    expect(isLabelCollisionBlock(e)).toBe(true);
    const mixed = classifyMergeError(422, {
      error: 'Merge is blocked', code: 'blocked',
      blockers: [{ code: 'label_collision', message: 'x' }, { code: 'agent_node', message: 'y' }],
    });
    expect(mixed.message).toBe('Merge is blocked');
    expect(isLabelCollisionBlock(mixed)).toBe(false);
    expect(isLabelCollisionBlock({ kind: 'blocked', blockers: [] })).toBe(false);
  });

  it('maps 503 unavailable to a non-retryable error', () => {
    const e = classifyMergeError(503, { error: 'Node merge is not available.', code: 'unavailable' });
    expect(e).toEqual({ kind: 'unavailable', code: 'unavailable', message: MERGE_UNAVAILABLE_MESSAGE, blockers: [] });
    expect(isRetryable(e)).toBe(false);
  });

  it('says which errors are worth retrying', () => {
    expect(isRetryable({ kind: 'server' })).toBe(true);
    expect(isRetryable({ kind: 'invalid' })).toBe(true);
    for (const kind of ['blocked', 'not_found', 'unavailable', 'unknown'] as const) {
      expect(isRetryable({ kind })).toBe(false);
    }
  });

  it('maps 404 and anything else', () => {
    expect(classifyMergeError(404, { code: 'node_not_found' })).toMatchObject({ kind: 'not_found', code: 'node_not_found' });
    expect(classifyMergeError(500, 'oops')).toEqual({
      kind: 'server', code: null, message: 'Merge failed (HTTP 500).', blockers: [],
    });
    expect(classifyMergeError(503, { code: 'made_up' }).code).toBeNull();
  });
});

describe('classifyApplyError', () => {
  const unknown = { kind: 'unknown', code: null, message: APPLY_OUTCOME_UNKNOWN_MESSAGE, blockers: [] };

  it('reports gateway errors and unreadable bodies as an unknown outcome', () => {
    expect(classifyApplyError(502, { error: 'Bad gateway' })).toEqual(unknown);
    expect(classifyApplyError(504, { error: 'Timeout' })).toEqual(unknown);
    expect(classifyApplyError(503, { error: 'Service unavailable' })).toEqual(unknown);
    expect(classifyApplyError(500, null)).toEqual(unknown);
    expect(classifyApplyError(422, 'not json')).toEqual(unknown);
    expect(outcomeUnknownError()).toEqual(unknown);
  });

  it('defers to classifyMergeError for the server’s own JSON errors', () => {
    expect(classifyApplyError(503, { error: 'x', code: 'unavailable' }).kind).toBe('unavailable');
    expect(classifyApplyError(409, { error: 'x', code: 'stale_preview' }).kind).toBe('stale');
    expect(classifyApplyError(422, { error: 'x', code: 'blocked', blockers: [] }).kind).toBe('blocked');
    expect(classifyApplyError(500, { error: 'boom' })).toMatchObject({ kind: 'server', message: 'boom' });
  });
});

describe('merge result warnings', () => {
  it('words the known codes and shows unknown ones raw', () => {
    expect(mergeResultWarningText('embedding_not_refreshed')).toMatch(/similarity suggestions/);
    expect(mergeResultWarningText('audit_event_not_recorded')).toMatch(/audit log entry could not be written.*server logs/);
    expect(mergeResultWarningText('identity_refresh_failed')).toMatch(/restart may be needed.*identities/);
    expect(mergeResultWarningText('brand_new_code')).toBe('brand_new_code');
  });

  it('lists each distinct warning once, skipping junk', () => {
    expect(mergeResultNotes(['embedding_not_refreshed', 'embedding_not_refreshed', '', 7, 'x'])).toEqual([
      mergeResultWarningText('embedding_not_refreshed'), 'x',
    ]);
    expect(mergeResultNotes([])).toEqual([]);
    expect(mergeResultNotes(undefined)).toEqual([]);
  });
});

describe('merged-node deep links', () => {
  it('extracts mergedInto only from node_merged bodies', () => {
    expect(mergedIntoFrom({ error: 'merged', code: 'node_merged', mergedInto: S })).toEqual({ mergedInto: S, label: null });
    expect(mergedIntoFrom({ code: 'node_merged', mergedInto: S, label: 'Old Acme' })).toEqual({ mergedInto: S, label: 'Old Acme' });
    expect(mergedIntoFrom({ code: 'node_not_found' })).toBeNull();
    expect(mergedIntoFrom({ code: 'node_merged', mergedInto: '' })).toBeNull();
    expect(mergedIntoFrom(null)).toBeNull();
  });

  it('words the notices', () => {
    expect(mergedIntoNotice('Old Acme')).toBe('‘Old Acme’ was merged into this node.');
    expect(mergedIntoNotice(null)).toBe('The node you opened was merged into this one.');
    expect(mergeSuccessMessage('Acme Summit', 'Acme')).toBe('Merged ‘Acme Summit’ into ‘Acme’.');
  });
});

describe('applyMergeToNodeList', () => {
  it('drops the absorbed node and refreshes the survivor in place', () => {
    const list = [node({ id: 'x' }), node({ id: S, label: 'Acme' }), node({ id: A })];
    const after = applyMergeToNodeList(list, { survivorId: S, absorbedId: A, node: node({ id: S, label: 'ACME Corp' }) });
    expect(after.map(n => [n.id, n.label])).toEqual([['x', 'Acme'], [S, 'ACME Corp']]);
  });

  it('leaves a list without either node untouched', () => {
    const list = [node({ id: 'x' })];
    expect(applyMergeToNodeList(list, { survivorId: S, absorbedId: A, node: node() })).toEqual(list);
  });
});
