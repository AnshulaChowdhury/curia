// resolve.ts — pure: a plan plus the user's resolutions → the execution plan.
//
// Spec: docs/wip/2026-10-21-kg-node-merge-design.md §7 step 2. Validation failures are
// typed (InvalidResolutionError / MergeBlockedError) so the route maps them to 400 / 422.
// The clock is a parameter, so a test can pin `replaced_at` / `merged_at`.

import type { MergedContactRow } from '../contacts/contact-service.js';
import { isStructuralContact } from '../contacts/contact-service.js';
import { InvalidResolutionError, MergeBlockedError } from './errors.js';
import { ownValue, setOwn } from './own.js';
import { buildFactOperations, computeAliases, foldTier, mostDurable, summaryCounts } from './planner.js';
import { PRINCIPAL_PRIMARY_FIELDS } from './types.js';
import type {
  ContactOperations,
  EdgeOperations,
  ExecutionPlan,
  FactChoice,
  FactOperations,
  MergePlan,
  NearDuplicateChoice,
  NodeMergeResolutions,
  Side,
} from './types.js';

const SIDES: ReadonlySet<string> = new Set(['survivor', 'absorbed']);
const FACT_CHOICES: ReadonlySet<string> = new Set(['survivor', 'absorbed', 'both']);
const NEAR_CHOICES: ReadonlySet<string> = new Set(['merge', 'keep_both']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChoiceMap<T extends string>(
  raw: unknown,
  name: string,
  allowed: ReadonlySet<string>,
): Record<string, T> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidResolutionError('invalid_request', `resolutions.${name} must be an object.`);
  }
  // Null prototype: a `__proto__` key is kept as a key (and reported if unknown), not dropped.
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new InvalidResolutionError(
        'invalid_request',
        `resolutions.${name}["${key}"] must be one of: ${[...allowed].join(', ')}.`,
      );
    }
    setOwn(out, key, value as T);
  }
  return out;
}

/**
 * Validate the shape of a request's `resolutions` (from untrusted JSON). Does not check
 * ids against a plan — applyResolutions does that.
 */
export function parseResolutions(raw: unknown): NodeMergeResolutions {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new InvalidResolutionError('invalid_request', 'resolutions must be an object.');
  }
  const out: NodeMergeResolutions = {};
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== 'string' || !SIDES.has(raw.label)) {
      throw new InvalidResolutionError('invalid_request', "resolutions.label must be 'survivor' or 'absorbed'.");
    }
    out.label = raw.label as Side;
  }
  const properties = parseChoiceMap<Side>(raw.properties, 'properties', SIDES);
  if (properties) out.properties = properties;
  const facts = parseChoiceMap<FactChoice>(raw.facts, 'facts', FACT_CHOICES);
  if (facts) out.facts = facts;
  const near = parseChoiceMap<NearDuplicateChoice>(raw.nearDuplicateFacts, 'nearDuplicateFacts', NEAR_CHOICES);
  if (near) out.nearDuplicateFacts = near;
  const contactFields = parseChoiceMap<Side>(raw.contactFields, 'contactFields', SIDES);
  if (contactFields) out.contactFields = contactFields;
  const authOverrides = parseChoiceMap<Side>(raw.authOverrides, 'authOverrides', SIDES);
  if (authOverrides) out.authOverrides = authOverrides;
  if (raw.acknowledgements !== undefined && raw.acknowledgements !== null) {
    if (!Array.isArray(raw.acknowledgements) || raw.acknowledgements.some(a => typeof a !== 'string')) {
      throw new InvalidResolutionError('invalid_request', 'resolutions.acknowledgements must be an array of strings.');
    }
    out.acknowledgements = raw.acknowledgements as string[];
  }
  return out;
}

function unknownKeys(given: Record<string, unknown> | undefined, known: Set<string>, name: string): string[] {
  return Object.keys(given ?? {}).filter(k => !known.has(k)).map(k => `${name}:${k}`);
}

/**
 * Apply resolutions to a plan. Throws:
 * - MergeBlockedError — the plan has blockers, or the chosen label collides with a third node;
 * - InvalidResolutionError('unknown_resolution') — an id the plan does not contain;
 * - InvalidResolutionError('ack_required') — a requiresAck warning was not acknowledged.
 * A missing resolution means the conflict's default.
 */
export function applyResolutions(
  plan: MergePlan,
  resolutions: NodeMergeResolutions,
  now: Date = new Date(),
): ExecutionPlan {
  const { preview } = plan;
  if (preview.blockers.length > 0) throw new MergeBlockedError(preview.blockers);

  const unknown = [
    ...unknownKeys(resolutions.properties, new Set(plan.node.propertyConflicts.map(c => c.key)), 'properties'),
    ...unknownKeys(resolutions.facts, new Set(plan.facts.conflicts.map(c => c.id)), 'facts'),
    ...unknownKeys(resolutions.nearDuplicateFacts, new Set(plan.facts.nearDuplicates.map(n => n.id)), 'nearDuplicateFacts'),
    ...unknownKeys(resolutions.contactFields, new Set(plan.contacts.fieldConflicts.map(c => c.field)), 'contactFields'),
    ...unknownKeys(resolutions.authOverrides, new Set(plan.contacts.authOverrideConflicts.map(c => c.permission)), 'authOverrides'),
  ];
  if (unknown.length > 0) {
    throw new InvalidResolutionError(
      'unknown_resolution',
      `These resolutions do not match any conflict in the current plan: ${unknown.join(', ')}.`,
    );
  }

  const acknowledged = new Set(resolutions.acknowledgements ?? []);
  const missingAcks = preview.warnings.filter(w => w.requiresAck && !acknowledged.has(w.code)).map(w => w.code);
  if (missingAcks.length > 0) {
    throw new InvalidResolutionError(
      'ack_required',
      `These warnings must be acknowledged before merging: ${missingAcks.join(', ')}.`,
    );
  }

  const labelSide: Side = resolutions.label ?? 'survivor';
  if (labelSide === 'absorbed' && preview.warnings.some(w => w.code === 'label_collision')) {
    throw new MergeBlockedError([{
      code: 'label_collision',
      message: `‘${preview.result.labels.absorbed}’ cannot be the name: another ${preview.result.type} node already uses it.`,
    }]);
  }

  const mergedAt = now.toISOString();
  const s = plan.snapshot.survivor.node;
  const a = plan.snapshot.absorbed.node;

  // -- Filled-in resolutions (the audit payload records every choice, default or not) --
  const filled: Required<NodeMergeResolutions> = {
    label: labelSide,
    // Own-property lookups: a property key or permission named like an Object.prototype
    // member (`constructor`) must fall back to the default, not read the inherited value.
    properties: Object.fromEntries(plan.node.propertyConflicts.map(c => [c.key, ownValue(resolutions.properties, c.key) ?? c.default])),
    facts: Object.fromEntries(plan.facts.conflicts.map(c => [c.id, ownValue(resolutions.facts, c.id) ?? c.default])),
    nearDuplicateFacts: Object.fromEntries(
      plan.facts.nearDuplicates.map(n => [n.id, ownValue(resolutions.nearDuplicateFacts, n.id) ?? 'merge']),
    ),
    contactFields: Object.fromEntries(
      plan.contacts.fieldConflicts.map(c => [c.field, ownValue(resolutions.contactFields, c.field) ?? 'survivor']),
    ),
    authOverrides: Object.fromEntries(
      plan.contacts.authOverrideConflicts.map(c => [c.permission, ownValue(resolutions.authOverrides, c.permission) ?? c.default]),
    ),
    acknowledgements: [...acknowledged].sort(),
  };

  // -- Node --
  const { label, aliases } = computeAliases(s, a, labelSide);
  const properties: Record<string, unknown> = { ...plan.node.mergedProperties };
  for (const conflict of plan.node.propertyConflicts) {
    setOwn(properties, conflict.key, ownValue(filled.properties, conflict.key) === 'absorbed' ? conflict.absorbedValue : conflict.survivorValue);
  }

  // -- Facts --
  const built = buildFactOperations(plan.facts, filled, mergedAt);
  const facts: FactOperations = {
    deleteFactIds: built.deleteFactIds,
    relinkEdgeIds: built.relinkEdgeIds,
    deleteLinkEdgeIds: built.deleteLinkEdgeIds,
    repointOutsideEdges: built.repointOutsideEdges,
    dropOutsideEdgeIds: built.dropOutsideEdgeIds,
    updates: [...built.updates.values()]
      .map(u => {
        const existing = Array.isArray(u.fact.properties.previous_values)
          ? (u.fact.properties.previous_values as Record<string, unknown>[])
          : [];
        return {
          id: u.fact.id,
          confidence: u.confidence,
          lastConfirmedAt: u.lastConfirmedAt,
          sensitivity: u.sensitivity,
          properties: u.previousValues.length > 0
            ? { ...u.fact.properties, previous_values: [...existing, ...u.previousValues] }
            : u.fact.properties,
        };
      })
      .sort((x, y) => x.id.localeCompare(y.id)),
    movedFactCount: built.movedFactIds.size,
    collapsedFactCount: built.collapsedFactCount,
  };

  // -- Edges --
  const edges: EdgeOperations = {
    deleteEdgeIds: [
      ...plan.edges.dropped.map(e => e.id),
      ...plan.edges.collapsed.map(c => c.absorbedEdge.id),
    ].sort(),
    collapses: plan.edges.collapsed.map(({ absorbedEdge, survivorEdge }) => ({
      survivorEdgeId: survivorEdge.id,
      absorbedEdgeId: absorbedEdge.id,
      confidence: Math.max(survivorEdge.confidence, absorbedEdge.confidence),
      lastConfirmedAt: survivorEdge.lastConfirmedAt >= absorbedEdge.lastConfirmedAt
        ? survivorEdge.lastConfirmedAt
        : absorbedEdge.lastConfirmedAt,
      decayClass: mostDurable(survivorEdge.decayClass, absorbedEdge.decayClass),
      // The survivor wins on a key both edges hold.
      properties: { ...absorbedEdge.properties, ...survivorEdge.properties },
    })),
    moveEdgeIds: plan.edges.moved.map(e => e.id).sort(),
  };

  // -- Contacts --
  const contacts = buildContactOperations(plan, filled, label);

  const conflictsResolved = plan.node.propertyConflicts.length
    + plan.facts.conflicts.length
    + plan.facts.nearDuplicates.length
    + plan.contacts.fieldConflicts.length
    + plan.contacts.authOverrideConflicts.length;

  return {
    survivorId: s.id,
    absorbedId: a.id,
    mergedAt,
    survivor: { id: s.id, type: s.type, label: s.label },
    absorbed: { id: a.id, type: a.type, label: a.label },
    crossType: s.type !== a.type,
    node: {
      label,
      labelChanged: label !== s.label,
      aliases,
      properties,
      confidence: plan.node.confidence,
      decayClass: plan.node.decayClass,
      sensitivity: plan.node.sensitivity,
      createdAt: plan.node.createdAt,
      lastConfirmedAt: plan.node.lastConfirmedAt,
      warnedAt: plan.node.warnedAt,
      warnReason: plan.node.warnReason,
      identitySource: plan.node.identitySource,
    },
    facts,
    edges,
    contacts,
    summary: { ...summaryCounts(plan.edges, built), conflictsResolved },
    resolutions: filled,
  };
}

function buildContactOperations(
  plan: MergePlan,
  filled: Required<NodeMergeResolutions>,
  finalLabel: string,
): ContactOperations {
  const cp = plan.contacts;
  const surviving = cp.surviving;
  const ops: ContactOperations = {
    action: cp.action,
    survivingContactId: surviving?.id ?? null,
    repoints: cp.repointed.map(r => ({ contactId: r.contact.id, kind: r.kind })),
    merges: [],
    mergedRow: null,
    mergedContactIds: cp.merged.map(c => c.id),
    repointedContactIds: cp.repointed.map(r => r.contact.id),
    survivingIsPrincipal: surviving?.systemRole === 'principal',
    principalIdentitiesTransferred: surviving?.systemRole === 'principal' ? [...cp.principalIdentitiesTransferred] : [],
    principalPrimaryFieldsFilled: {},
  };
  if (cp.action !== 'merge' || !surviving) return ops;

  // Field values: the non-conflicting base, then each conflict as chosen.
  const fields = { ...cp.fieldBase };
  for (const conflict of cp.fieldConflicts) {
    fields[conflict.field] = filled.contactFields[conflict.field] === 'absorbed' ? conflict.absorbedValue : conflict.survivorValue;
  }

  // Trust audit: primary email / phone the fold writes onto the principal (filled where it
  // had none, or replaced by a conflict resolved to the absorbed side).
  if (ops.survivingIsPrincipal) {
    for (const field of PRINCIPAL_PRIMARY_FIELDS) {
      const value = fields[field];
      if (value !== null && value !== surviving.fields[field]) ops.principalPrimaryFieldsFilled[field] = value;
    }
  }

  const all = [surviving, ...cp.merged];
  const lastSeen = all.map(c => c.lastSeenAt).filter((v): v is string => v !== null).sort().at(-1) ?? null;
  const noteParts = all.map(c => c.notes).filter((n): n is string => typeof n === 'string' && n.length > 0);

  ops.mergedRow = {
    kgNodeId: plan.snapshot.survivor.node.id,
    // A structural survivor contact keeps its own display name (§5.1).
    displayName: isStructuralContact(surviving) ? surviving.displayName : finalLabel,
    role: fields.role,
    notes: noteParts.length > 0 ? noteParts.join('\n---\n') : null,
    tier: foldTier(surviving, cp.merged),
    kind: cp.resultingKind ?? surviving.kind,
    preferredName: fields.preferred_name,
    title: fields.title,
    organization: fields.organization,
    primaryEmail: fields.primary_email,
    primaryPhone: fields.primary_phone,
    timezone: fields.timezone,
    locale: fields.locale,
    location: fields.location,
    pronouns: fields.pronouns,
    linkedinUrl: fields.linkedin_url,
    bio: fields.bio,
    birthday: fields.birthday,
    contactConfidence: Math.max(...all.map(c => c.contactConfidence)),
    lastSeenAt: lastSeen ? new Date(lastSeen) : null,
    inboundMessageCount: all.reduce((sum, c) => sum + c.inboundMessageCount, 0),
    outboundMessageCount: all.reduce((sum, c) => sum + c.outboundMessageCount, 0),
  } satisfies MergedContactRow;

  // An override conflict resolved to the absorbed side: the survivor's row is revoked
  // just before the contact holding the absorbed value is folded in.
  const preferAbsorbed = new Map<string, string[]>();
  const prefer = (contactId: string, permission: string) =>
    preferAbsorbed.set(contactId, [...(preferAbsorbed.get(contactId) ?? []), permission]);
  for (const c of cp.authOverrideConflicts) {
    if (filled.authOverrides[c.permission] === 'absorbed') prefer(c.absorbedContactId, c.permission);
  }
  // Folded contacts that disagree where the survivor holds no override: the deny wins.
  for (const p of cp.foldOverridePreferences) prefer(p.contactId, p.permission);
  ops.merges = cp.merged.map(m => ({ secondaryId: m.id, overridesPreferSecondary: preferAbsorbed.get(m.id) ?? [] }));
  return ops;
}
