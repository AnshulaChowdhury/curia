// planner.ts — pure merge planning: snapshot in, plan out. No DB, no clock, no I/O.
//
// Spec: docs/wip/2026-10-21-kg-node-merge-design.md §4 (survivorship), §5 (contacts),
// §8 (preview shape and deterministic ids). Everything here is a function of the snapshot
// alone, so the same data always yields the same plan, token and conflict ids — that is
// what lets apply() recompute the plan under row locks and compare tokens.

import { createHash } from 'node:crypto';
import { EmbeddingService } from '../memory/embedding.js';
import { MAX_ALIASES_PER_ENTITY } from '../memory/entity-memory.js';
import { maxSensitivity } from '../memory/sensitivity.js';
import type { DecayClass } from '../memory/types.js';
import { DEDUP_SIMILARITY_THRESHOLD } from '../memory/validation.js';
import { isStructuralContact } from '../contacts/contact-service.js';
import { TIER_RANK, type ContactTier } from '../contacts/types.js';
import {
  CONTACT_MERGE_FIELD_LABELS,
  CONTACT_MERGE_FIELDS,
  type AuthOverrideConflictPlan,
  type ContactFieldConflictPlan,
  type ContactMergeField,
  type ContactPlan,
  type ContactPlanView,
  type EdgePlan,
  type FactChoice,
  type FactCollapse,
  type FactConflictPlan,
  type FactMove,
  type FactPlan,
  type MergeBlocker,
  type MergeFactSummary,
  type MergeNodeSummary,
  type MergePlan,
  type MergeSide,
  type MergeSnapshot,
  type MergeSummaryCounts,
  type MergeWarning,
  type NearDuplicateChoice,
  type NearDuplicatePlan,
  type NodePlan,
  type PropertyConflict,
  type Side,
  type SnapshotContact,
  type SnapshotFact,
  type SnapshotNode,
} from './types.js';

/** Properties never copied from the absorbed node (§4.1). */
export const RESERVED_PROPERTY_KEYS: ReadonlySet<string> = new Set(['merged_into', 'merged_at', 'is_agent']);

const DECAY_RANK: Record<DecayClass, number> = { fast_decay: 0, slow_decay: 1, permanent: 2 };

// ---------------------------------------------------------------------------
// Canonical serialization and the plan token
// ---------------------------------------------------------------------------

/** JSON with object keys sorted recursively, so equal data always serializes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 over the canonical snapshot (§3). Changes whenever anything the plan reads changes. */
export function planToken(snapshot: MergeSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Lower-case, collapse whitespace, strip trailing '.'/'!' (§4.3 non-attribute facts). */
export function normalizeFactText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
}

function factAttribute(fact: SnapshotNode): string | null {
  const raw = fact.properties.attribute;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function factValueString(fact: SnapshotNode): string | null {
  const raw = fact.properties.value;
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' ? raw : canonicalJson(raw);
}

/** The value an attribute fact asserts: normalized properties.value, else the normalized label. */
function factValueKey(fact: SnapshotNode): string {
  const value = factValueString(fact);
  return normalizeFactText(value ?? fact.label);
}

function isMultiValued(fact: SnapshotNode): boolean {
  return fact.properties.multi_valued === true;
}

/** Newest by last_confirmed_at; ties broken by id so the choice is deterministic. */
function newest<T extends { lastConfirmedAt: string; id: string }>(items: T[]): T {
  return [...items].sort((a, b) =>
    b.lastConfirmedAt.localeCompare(a.lastConfirmedAt) || a.id.localeCompare(b.id),
  )[0]!;
}

/** The newer side by last_confirmed_at; the survivor on a tie (§4.2). */
function newerSide(survivorConfirmedAt: string, absorbedConfirmedAt: string): Side {
  return absorbedConfirmedAt > survivorConfirmedAt ? 'absorbed' : 'survivor';
}

export function mostDurable(a: DecayClass, b: DecayClass): DecayClass {
  return DECAY_RANK[a] >= DECAY_RANK[b] ? a : b;
}

function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}

export function isAgentNode(side: MergeSide): boolean {
  return String(side.node.properties.is_agent) === 'true'
    || side.contacts.some(c => c.systemRole === 'agent' || c.kind === 'agent');
}

function isPrincipalContact(c: SnapshotContact): boolean {
  return c.systemRole === 'principal';
}

function identityKey(channel: string, identifier: string): string {
  return `${channel}:${channel === 'email' ? identifier.toLowerCase() : identifier}`;
}

/** Sort contacts by created_at then id — the order the snapshot loads them in. */
function byCreation(a: SnapshotContact, b: SnapshotContact): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Aliases (§4.1)
// ---------------------------------------------------------------------------

/**
 * Aliases for a given label choice: survivor aliases, then the unchosen label, then the
 * absorbed aliases — lower-cased, de-duplicated, minus the final label, capped.
 */
export function computeAliases(
  survivor: Pick<SnapshotNode, 'label' | 'aliases'>,
  absorbed: Pick<SnapshotNode, 'label' | 'aliases'>,
  label: Side,
): { label: string; aliases: string[]; droppedAliases: string[] } {
  const finalLabel = label === 'absorbed' ? absorbed.label : survivor.label;
  const otherLabel = label === 'absorbed' ? survivor.label : absorbed.label;
  const finalKey = finalLabel.trim().toLowerCase();
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of [...survivor.aliases, otherLabel, ...absorbed.aliases]) {
    const alias = raw.trim().toLowerCase();
    if (alias.length === 0 || alias === finalKey || seen.has(alias)) continue;
    seen.add(alias);
    all.push(alias);
  }
  return {
    label: finalLabel,
    aliases: all.slice(0, MAX_ALIASES_PER_ENTITY),
    droppedAliases: all.slice(MAX_ALIASES_PER_ENTITY),
  };
}

// ---------------------------------------------------------------------------
// Facts (§4.3)
// ---------------------------------------------------------------------------

export function factConflictId(survivorFactId: string, absorbedFactId: string): string {
  return `fact:${survivorFactId}:${absorbedFactId}`;
}

export function nearDuplicateId(survivorFactId: string, absorbedFactId: string): string {
  return `near:${survivorFactId}:${absorbedFactId}`;
}

function groupByAttribute(facts: SnapshotFact[]): Map<string, SnapshotFact[]> {
  const groups = new Map<string, SnapshotFact[]>();
  for (const fact of facts) {
    const attr = factAttribute(fact.node);
    if (attr === null) continue;
    const group = groups.get(attr) ?? [];
    group.push(fact);
    groups.set(attr, group);
  }
  return groups;
}

export function planFacts(survivor: MergeSide, absorbed: MergeSide): FactPlan {
  const survivorFactIds = new Set(survivor.facts.map(f => f.node.id));
  const shared = absorbed.facts.filter(f => survivorFactIds.has(f.node.id));
  const absorbedOnly = absorbed.facts.filter(f => !survivorFactIds.has(f.node.id));

  const moves: FactMove[] = [];
  const collapses: FactCollapse[] = [];
  const conflicts: FactConflictPlan[] = [];
  const nearDuplicates: NearDuplicatePlan[] = [];
  const collapseTargets = new Set<string>();

  const collapse = (s: SnapshotNode, a: SnapshotNode): void => {
    collapses.push({ survivorFact: s, absorbedFact: a });
    collapseTargets.add(s.id);
  };

  // 1. Attribute facts, grouped by normalized attribute.
  const survivorByAttr = groupByAttribute(survivor.facts);
  const absorbedByAttr = groupByAttribute(absorbedOnly);
  for (const attr of [...absorbedByAttr.keys()].sort()) {
    const aGroup = absorbedByAttr.get(attr)!;
    const sGroup = survivorByAttr.get(attr);
    if (!sGroup) {
      moves.push(...aGroup.map(f => ({ fact: f.node, linkEdgeIds: f.linkEdgeIds })));
      continue;
    }
    // Same value as some survivor fact of this attribute → automatic duplicate. The newest
    // matching survivor fact keeps it.
    const remaining: SnapshotFact[] = [];
    for (const aFact of aGroup) {
      const key = factValueKey(aFact.node);
      const matches = sGroup.filter(s => factValueKey(s.node) === key).map(s => s.node);
      if (matches.length > 0) {
        collapse(newest(matches), aFact.node);
      } else {
        remaining.push(aFact);
      }
    }
    if (remaining.length === 0) continue;

    // A multi-valued attribute holds several values at once: different values are not a
    // contradiction (storeFact's rule, #1623), so they all move.
    const multi = [...sGroup, ...remaining].some(f => isMultiValued(f.node));
    if (multi) {
      moves.push(...remaining.map(f => ({ fact: f.node, linkEdgeIds: f.linkEdgeIds })));
      continue;
    }

    // Conflict compares the newest fact on each side; the others move unchanged.
    const sNewest = newest(sGroup.map(f => f.node));
    const aNewestNode = newest(remaining.map(f => f.node));
    const aNewest = remaining.find(f => f.node.id === aNewestNode.id)!;
    conflicts.push({
      id: factConflictId(sNewest.id, aNewest.node.id),
      attribute: attr,
      survivorFact: sNewest,
      absorbedFact: aNewest.node,
      absorbedLinkEdgeIds: aNewest.linkEdgeIds,
      default: newerSide(sNewest.lastConfirmedAt, aNewest.node.lastConfirmedAt),
    });
    for (const other of remaining) {
      if (other.node.id !== aNewest.node.id) moves.push({ fact: other.node, linkEdgeIds: other.linkEdgeIds });
    }
  }

  // 2. Non-attribute facts: exact (normalized) label duplicates collapse.
  const survivorPlain = survivor.facts.filter(f => factAttribute(f.node) === null);
  const byLabel = new Map<string, SnapshotNode[]>();
  for (const s of survivorPlain) {
    const key = normalizeFactText(s.node.label);
    byLabel.set(key, [...(byLabel.get(key) ?? []), s.node]);
  }
  const plainRemaining: SnapshotFact[] = [];
  for (const aFact of absorbedOnly.filter(f => factAttribute(f.node) === null)) {
    const matches = byLabel.get(normalizeFactText(aFact.node.label));
    if (matches && matches.length > 0) {
      collapse(newest(matches), aFact.node);
    } else {
      plainRemaining.push(aFact);
    }
  }

  // 3. Near-duplicates by embedding. Greedy by similarity so each absorbed fact pairs with
  // its best match and each survivor fact with at most one absorbed fact. Survivor facts
  // that already absorbed an exact duplicate are left out of pairing.
  const pairs: { s: SnapshotNode; a: SnapshotFact; similarity: number }[] = [];
  for (const aFact of plainRemaining) {
    const aEmb = aFact.node.embedding;
    if (!aEmb) continue;
    for (const s of survivorPlain) {
      const sEmb = s.node.embedding;
      if (!sEmb || sEmb.length !== aEmb.length || collapseTargets.has(s.node.id)) continue;
      const similarity = EmbeddingService.cosineSimilarity(sEmb, aEmb);
      if (similarity >= DEDUP_SIMILARITY_THRESHOLD) pairs.push({ s: s.node, a: aFact, similarity });
    }
  }
  pairs.sort((x, y) =>
    y.similarity - x.similarity || x.a.node.id.localeCompare(y.a.node.id) || x.s.id.localeCompare(y.s.id),
  );
  const pairedSurvivor = new Set<string>();
  const pairedAbsorbed = new Set<string>();
  for (const pair of pairs) {
    if (pairedSurvivor.has(pair.s.id) || pairedAbsorbed.has(pair.a.node.id)) continue;
    pairedSurvivor.add(pair.s.id);
    pairedAbsorbed.add(pair.a.node.id);
    nearDuplicates.push({
      id: nearDuplicateId(pair.s.id, pair.a.node.id),
      survivorFact: pair.s,
      absorbedFact: pair.a.node,
      absorbedLinkEdgeIds: pair.a.linkEdgeIds,
      // Rounded so the preview is stable across float formatting.
      similarity: Math.round(pair.similarity * 10_000) / 10_000,
    });
  }
  nearDuplicates.sort((x, y) => x.id.localeCompare(y.id));
  for (const aFact of plainRemaining) {
    if (!pairedAbsorbed.has(aFact.node.id)) moves.push({ fact: aFact.node, linkEdgeIds: aFact.linkEdgeIds });
  }

  moves.sort((x, y) => x.fact.id.localeCompare(y.fact.id));
  collapses.sort((x, y) => x.absorbedFact.id.localeCompare(y.absorbedFact.id));
  conflicts.sort((x, y) => x.id.localeCompare(y.id));

  return {
    moves,
    collapses,
    conflicts,
    nearDuplicates,
    sharedFactIds: shared.map(f => f.node.id).sort(),
    sharedLinkEdgeIds: shared.flatMap(f => f.linkEdgeIds).sort(),
  };
}

// ---------------------------------------------------------------------------
// Fact operations for a set of choices — shared by the preview summary and resolve.ts
// ---------------------------------------------------------------------------

export interface FactChoices {
  facts: Record<string, FactChoice>;
  nearDuplicateFacts: Record<string, NearDuplicateChoice>;
}

export interface BuiltFactOperations {
  deleteFactIds: string[];
  relinkEdgeIds: string[];
  deleteLinkEdgeIds: string[];
  updates: Map<string, { fact: SnapshotNode; confidence: number; lastConfirmedAt: string; sensitivity: SnapshotNode['sensitivity']; previousValues: Record<string, unknown>[] }>;
  movedFactIds: Set<string>;
  collapsedFactCount: number;
}

/** A previous_values entry recording a value the merge dropped (§4.3). */
export function previousValueEntry(dropped: SnapshotNode, replacedAt: string): Record<string, unknown> {
  return {
    value: factValueString(dropped) ?? dropped.label,
    label: dropped.label,
    confidence: dropped.confidence,
    source: dropped.source,
    replaced_at: replacedAt,
    reason: 'node_merge',
  };
}

/** The previous_values history a fact node already carries; it must outlive the node. */
function existingHistory(fact: SnapshotNode): Record<string, unknown>[] {
  const history = fact.properties.previous_values;
  return Array.isArray(history)
    ? history.filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
    : [];
}

export function buildFactOperations(plan: FactPlan, choices: FactChoices, replacedAt: string): BuiltFactOperations {
  const deleteFactIds = new Set<string>();
  /** fact id → its absorbed-side link edges to re-point */
  const relinks = new Map<string, string[]>();
  const movedFactIds = new Set<string>();
  const updates: BuiltFactOperations['updates'] = new Map();
  let collapsedFactCount = plan.sharedFactIds.length;

  const update = (fact: SnapshotNode) => {
    let u = updates.get(fact.id);
    if (!u) {
      u = {
        fact,
        confidence: fact.confidence,
        lastConfirmedAt: fact.lastConfirmedAt,
        sensitivity: fact.sensitivity,
        previousValues: [],
      };
      updates.set(fact.id, u);
    }
    return u;
  };
  // keep absorbs drop: max confidence, newest confirmation, highest sensitivity.
  const absorbInto = (keep: SnapshotNode, drop: SnapshotNode) => {
    const u = update(keep);
    u.confidence = Math.max(u.confidence, drop.confidence);
    u.lastConfirmedAt = maxIso(u.lastConfirmedAt, drop.lastConfirmedAt);
    u.sensitivity = maxSensitivity(u.sensitivity, drop.sensitivity);
    // The dropped node is deleted; its own value history moves to the kept fact.
    u.previousValues.push(...existingHistory(drop));
    deleteFactIds.add(drop.id);
  };
  const relink = (fact: SnapshotNode, linkEdgeIds: string[]) => {
    relinks.set(fact.id, linkEdgeIds);
    movedFactIds.add(fact.id);
  };

  for (const move of plan.moves) relink(move.fact, move.linkEdgeIds);

  for (const c of plan.collapses) {
    absorbInto(c.survivorFact, c.absorbedFact);
    collapsedFactCount++;
  }

  // The dropped value lives on in the kept fact's previous_values, so the kept fact must be
  // at least as sensitive as the dropped one — otherwise the merge would downgrade it.
  const keepWithPreviousValue = (keep: SnapshotNode, drop: SnapshotNode) => {
    const u = update(keep);
    u.sensitivity = maxSensitivity(u.sensitivity, drop.sensitivity);
    // The dropped node's own history first, then the value it held — so a winning absorbed
    // fact does not discard the survivor fact's earlier values with the node.
    u.previousValues.push(...existingHistory(drop), previousValueEntry(drop, replacedAt));
    deleteFactIds.add(drop.id);
  };

  for (const conflict of plan.conflicts) {
    const choice = choices.facts[conflict.id] ?? conflict.default;
    if (choice === 'both') {
      relink(conflict.absorbedFact, conflict.absorbedLinkEdgeIds);
    } else if (choice === 'survivor') {
      keepWithPreviousValue(conflict.survivorFact, conflict.absorbedFact);
    } else {
      relink(conflict.absorbedFact, conflict.absorbedLinkEdgeIds);
      keepWithPreviousValue(conflict.absorbedFact, conflict.survivorFact);
    }
  }

  for (const pair of plan.nearDuplicates) {
    const choice = choices.nearDuplicateFacts[pair.id] ?? 'merge';
    if (choice === 'keep_both') {
      relink(pair.absorbedFact, pair.absorbedLinkEdgeIds);
      continue;
    }
    // merge keeps the higher-confidence fact (the survivor's on a tie).
    if (pair.absorbedFact.confidence > pair.survivorFact.confidence) {
      absorbInto(pair.absorbedFact, pair.survivorFact);
      relink(pair.absorbedFact, pair.absorbedLinkEdgeIds);
    } else {
      absorbInto(pair.survivorFact, pair.absorbedFact);
    }
    collapsedFactCount++;
  }

  // A fact deleted later (e.g. a conflict lost to the absorbed side) needs no update, and
  // its link edges go with it.
  for (const id of deleteFactIds) {
    updates.delete(id);
    movedFactIds.delete(id);
    relinks.delete(id);
  }

  return {
    deleteFactIds: [...deleteFactIds].sort(),
    relinkEdgeIds: [...relinks.values()].flat().sort(),
    deleteLinkEdgeIds: [...plan.sharedLinkEdgeIds],
    updates,
    movedFactIds,
    collapsedFactCount,
  };
}

// ---------------------------------------------------------------------------
// Edges (§4.4)
// ---------------------------------------------------------------------------

export function planEdges(survivor: MergeSide, absorbed: MergeSide): EdgePlan {
  const sId = survivor.node.id;
  const aId = absorbed.node.id;
  const plan: EdgePlan = { dropped: [], collapsed: [], moved: [] };
  for (const edge of absorbed.edges) {
    const other = edge.sourceNodeId === aId ? edge.targetNodeId : edge.sourceNodeId;
    if (other === sId || other === aId) {
      plan.dropped.push(edge);
      continue;
    }
    // idx_kg_edges_unique: the unordered pair plus the type.
    const collision = survivor.edges.find(se =>
      se.type === edge.type
      && ((se.sourceNodeId === sId && se.targetNodeId === other) || (se.targetNodeId === sId && se.sourceNodeId === other)),
    );
    if (collision) {
      plan.collapsed.push({ absorbedEdge: edge, survivorEdge: collision });
    } else {
      plan.moved.push(edge);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Properties (§4.1–4.2)
// ---------------------------------------------------------------------------

export function planProperties(survivor: SnapshotNode, absorbed: SnapshotNode): {
  mergedProperties: Record<string, unknown>;
  conflicts: PropertyConflict[];
} {
  const merged: Record<string, unknown> = { ...survivor.properties };
  const conflicts: PropertyConflict[] = [];
  for (const key of Object.keys(absorbed.properties).sort()) {
    if (RESERVED_PROPERTY_KEYS.has(key)) continue;
    const absorbedValue = absorbed.properties[key];
    if (!(key in survivor.properties)) {
      merged[key] = absorbedValue;
      continue;
    }
    const survivorValue = survivor.properties[key];
    if (deepEqual(survivorValue, absorbedValue)) continue;
    conflicts.push({
      key,
      survivorValue,
      absorbedValue,
      default: newerSide(survivor.lastConfirmedAt, absorbed.lastConfirmedAt),
    });
  }
  return { mergedProperties: merged, conflicts };
}

// ---------------------------------------------------------------------------
// Contacts (§5)
// ---------------------------------------------------------------------------

function emptyFieldBase(): Record<ContactMergeField, string | null> {
  return Object.fromEntries(CONTACT_MERGE_FIELDS.map(f => [f, null])) as Record<ContactMergeField, string | null>;
}

function sameFieldValue(field: ContactMergeField, a: string, b: string): boolean {
  return field === 'primary_email' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function planContacts(
  survivor: MergeSide,
  absorbed: MergeSide,
  blockers: MergeBlocker[],
  warnings: MergeWarning[],
): ContactPlan {
  const type = survivor.node.type;
  const cs = [...survivor.contacts].sort(byCreation);
  const ca = [...absorbed.contacts].sort(byCreation);
  const plan: ContactPlan = {
    action: 'none',
    surviving: null,
    survivingFrom: null,
    merged: [],
    repointed: [],
    resultingKind: null,
    fieldBase: emptyFieldBase(),
    fieldConflicts: [],
    authOverrideConflicts: [],
    foldOverridePreferences: [],
  };

  if (type === 'person') {
    if (cs.length > 1) {
      blockers.push({
        code: 'survivor_multiple_contacts',
        message: `‘${survivor.node.label}’ is linked to ${cs.length} contacts. Merge those contacts on the Contacts page first.`,
      });
    }
    const surviving = cs[0] ?? ca[0] ?? null;
    if (!surviving) return plan;
    plan.surviving = surviving;
    plan.survivingFrom = cs[0] ? 'survivor' : 'absorbed';
    plan.merged = [...cs, ...ca].filter(c => c.id !== surviving.id);
    plan.resultingKind = isStructuralContact(surviving) ? surviving.kind : 'person';
    if (plan.survivingFrom === 'absorbed') {
      plan.repointed.push({ contact: surviving, kind: plan.resultingKind });
    }
    for (const m of plan.merged) {
      if (isStructuralContact(m)) {
        blockers.push({
          code: 'absorbed_structural_contact',
          message: `‘${m.displayName}’ is a system contact and cannot be merged away.`,
        });
      }
    }
    plan.action = plan.merged.length > 0 ? 'merge' : plan.repointed.length > 0 ? 'repoint' : 'none';
    if (plan.action === 'merge') planContactFields(plan, surviving, warnings);
    return plan;
  }

  if (type === 'organization') {
    for (const c of ca) {
      plan.repointed.push({ contact: c, kind: isStructuralContact(c) ? c.kind : 'organization' });
    }
    if (ca.length > 0) {
      plan.action = 'repoint';
      plan.resultingKind = 'organization';
      warnings.push({
        code: 'contacts_repointed',
        message: `${ca.length} contact${ca.length === 1 ? '' : 's'} now link${ca.length === 1 ? 's' : ''} to ‘${survivor.node.label}’; merge duplicates on the Contacts page.`,
        requiresAck: false,
        details: ca.map(c => c.displayName),
      });
    }
    return plan;
  }

  if (ca.length > 0) {
    blockers.push({
      code: 'absorbed_has_contacts_incompatible_type',
      message: `‘${absorbed.node.label}’ has a contact record, which a ${type} node cannot hold. Merge in the other direction, or into a person or organization.`,
    });
  }
  return plan;
}

/** A contact field value as shown in a warning line — quoted and, if long, shortened. */
function quoteValue(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return `'${flat.length > 60 ? `${flat.slice(0, 57)}...` : flat}'`;
}

function planContactFields(plan: ContactPlan, surviving: SnapshotContact, warnings: MergeWarning[]): void {
  // Lines for the contacts_disagree warning: values the surviving contact does not hold,
  // on which two or more folded contacts disagree, so one is kept by rule and not by choice.
  const disagreements: string[] = [];
  const mergedByCreation = [...plan.merged].sort(byCreation);

  for (const field of CONTACT_MERGE_FIELDS) {
    const survivorValue = surviving.fields[field];
    if (survivorValue !== null) {
      plan.fieldBase[field] = survivorValue;
      const differing = plan.merged
        .map(m => m.fields[field])
        .find((v): v is string => v !== null && !sameFieldValue(field, v, survivorValue));
      if (differing !== undefined) {
        plan.fieldConflicts.push({ field, survivorValue, absorbedValue: differing });
      }
      continue;
    }
    // No survivor value: the earliest-created folded contact holding one wins.
    const holders = mergedByCreation.filter(m => m.fields[field] !== null);
    const kept = holders[0];
    plan.fieldBase[field] = kept ? kept.fields[field] : null;
    if (!kept) continue;
    const keptValue = kept.fields[field]!;
    const losers = holders.filter(m => !sameFieldValue(field, m.fields[field]!, keptValue));
    if (losers.length > 0) {
      disagreements.push(
        `${CONTACT_MERGE_FIELD_LABELS[field]}: ${quoteValue(keptValue)} (${kept.displayName}) kept over `
        + losers.map(m => `${quoteValue(m.fields[field]!)} (${m.displayName})`).join(', '),
      );
    }
  }

  const survivorOverrides = new Map(surviving.authOverrides.map(o => [o.permission, o.granted]));
  const seen = new Set<string>();
  // permission → folded contacts holding an active override for it, in fold order.
  const unanchored = new Map<string, { contact: SnapshotContact; granted: boolean }[]>();
  for (const m of plan.merged) {
    for (const o of m.authOverrides) {
      const survivorGranted = survivorOverrides.get(o.permission);
      if (survivorGranted === undefined) {
        unanchored.set(o.permission, [...(unanchored.get(o.permission) ?? []), { contact: m, granted: o.granted }]);
        continue;
      }
      if (survivorGranted === o.granted || seen.has(o.permission)) continue;
      seen.add(o.permission);
      plan.authOverrideConflicts.push({
        permission: o.permission,
        survivorGranted,
        absorbedGranted: o.granted,
        absorbedContactId: m.id,
      });
    }
  }
  plan.authOverrideConflicts.sort((a, b) => a.permission.localeCompare(b.permission));

  // Folded contacts that disagree on a permission the survivor holds no override for: the
  // deny wins (the security-safe reading). A fold carries the first holder's override and
  // drops later same-permission rows, so when the first holder grants, the first denying
  // contact must be preferred at its fold.
  for (const permission of [...unanchored.keys()].sort()) {
    const holders = unanchored.get(permission)!;
    const firstDeny = holders.find(h => !h.granted);
    if (!firstDeny || !holders.some(h => h.granted)) continue;
    if (holders[0]!.granted) {
      plan.foldOverridePreferences.push({ permission, contactId: firstDeny.contact.id });
    }
    disagreements.push(`${permission}: denied kept over granted`);
  }

  if (disagreements.length > 0) {
    warnings.push({
      code: 'contacts_disagree',
      message: 'The contacts being merged disagree on values the surviving contact does not hold. '
        + 'For each field the earliest contact’s value is kept; for each permission, denied wins over granted.',
      requiresAck: false,
      details: disagreements,
    });
  }
}

/** Tier survivorship of a fold — computeGoldenRecord's rule applied across every contact. */
export function foldTier(surviving: SnapshotContact, merged: SnapshotContact[]): ContactTier {
  if (isStructuralContact(surviving)) return surviving.tier;
  const all = [surviving, ...merged];
  if (all.some(c => c.tier === 'blocked')) return 'blocked';
  return all.reduce<ContactTier>((best, c) => (TIER_RANK[c.tier] > TIER_RANK[best] ? c.tier : best), surviving.tier);
}

function contactPlanView(plan: ContactPlan, survivor: MergeSide): ContactPlanView {
  const survivorContactIds = new Set(survivor.contacts.map(c => c.id));
  const involved = plan.surviving ? [plan.surviving, ...plan.merged] : [];
  const seen = new Set<string>();
  const identities: ContactPlanView['identities'] = [];
  for (const c of involved) {
    const from: Side = survivorContactIds.has(c.id) ? 'survivor' : 'absorbed';
    for (const i of c.identities) {
      const key = identityKey(i.channel, i.identifier);
      identities.push({ channel: i.channel, identifier: i.identifier, from, duplicate: seen.has(key), verified: i.verified });
      seen.add(key);
    }
  }
  return {
    action: plan.action,
    survivingContactId: plan.surviving?.id ?? null,
    mergedContactIds: plan.merged.map(c => c.id),
    repointedContactIds: plan.repointed.map(r => r.contact.id),
    resultingKind: plan.resultingKind,
    identities,
  };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function nodeSummary(side: MergeSide): MergeNodeSummary {
  const n = side.node;
  return {
    id: n.id,
    label: n.label,
    type: n.type,
    aliases: [...n.aliases],
    identitySource: n.identitySource,
    sensitivity: n.sensitivity,
    confidence: n.confidence,
    decayClass: n.decayClass,
    lastConfirmedAt: n.lastConfirmedAt,
    factCount: side.facts.length,
    edgeCount: side.edges.length,
    contacts: side.contacts.map(c => ({
      id: c.id,
      displayName: c.displayName,
      kind: c.kind,
      systemRole: c.systemRole,
      tier: c.tier,
      identityCount: c.identities.length,
    })),
  };
}

export function factSummary(fact: SnapshotNode): MergeFactSummary {
  const attr = fact.properties.attribute;
  return {
    id: fact.id,
    label: fact.label,
    attribute: typeof attr === 'string' ? attr : null,
    value: factValueString(fact),
    confidence: fact.confidence,
    lastConfirmedAt: fact.lastConfirmedAt,
    source: fact.source,
    sensitivity: fact.sensitivity,
  };
}

export function summaryCounts(edges: EdgePlan, facts: BuiltFactOperations): MergeSummaryCounts {
  return {
    factsMoved: facts.movedFactIds.size,
    factsCollapsed: facts.collapsedFactCount,
    edgesMoved: edges.moved.length,
    edgesCollapsed: edges.collapsed.length,
    edgesDropped: edges.dropped.length,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export function planNodeMerge(snapshot: MergeSnapshot): MergePlan {
  const token = planToken(snapshot);
  const { survivor, absorbed } = snapshot;
  const s = survivor.node;
  const a = absorbed.node;
  const blockers: MergeBlocker[] = [];
  const warnings: MergeWarning[] = [];

  // -- Guards (§5.2, §7) --
  if (s.type === 'fact' || a.type === 'fact') {
    blockers.push({ code: 'fact_node', message: 'Fact nodes cannot be merged.' });
  }
  if (isAgentNode(survivor) || isAgentNode(absorbed)) {
    blockers.push({ code: 'agent_node', message: 'The agent’s own node cannot be merged.' });
  }
  const absorbedIsPrincipal = absorbed.contacts.some(isPrincipalContact);
  if (absorbedIsPrincipal) {
    blockers.push({
      code: 'absorbed_is_principal',
      message: `‘${a.label}’ is the principal’s node and cannot be merged away. Swap the direction to keep it.`,
    });
  }
  const survivorIsPrincipal = survivor.contacts.some(isPrincipalContact);

  // -- Contacts (§5) --
  const contacts = planContacts(survivor, absorbed, blockers, warnings);
  if (survivorIsPrincipal && contacts.merged.length > 0) {
    const survivorKeys = new Set(
      (contacts.surviving?.identities ?? []).map(i => identityKey(i.channel, i.identifier)),
    );
    const transferred: string[] = [];
    for (const m of contacts.merged) {
      for (const i of m.identities) {
        const key = identityKey(i.channel, i.identifier);
        if (survivorKeys.has(key)) continue;
        survivorKeys.add(key);
        transferred.push(`${i.channel}: ${i.identifier}`);
      }
    }
    warnings.push({
      code: 'principal_identity_transfer',
      message: transferred.length > 0
        ? `These identities will become principal identities, which carry principal-level trust.`
        : `The contact of ‘${a.label}’ will be folded into the principal’s contact.`,
      requiresAck: true,
      details: transferred,
    });
  }

  // -- Label collision (idx_kg_nodes_unique) --
  const resultIdentitySource = s.type === 'person' && contacts.surviving ? 'contact' : s.identitySource;
  const labelOwner = snapshot.absorbedLabelOwner;
  if (labelOwner && resultIdentitySource === 'label' && a.label.toLowerCase() !== s.label.toLowerCase()) {
    warnings.push({
      code: 'label_collision',
      message: `‘${a.label}’ cannot be the name: another ${s.type} node already uses it.`,
      requiresAck: false,
      details: [`${labelOwner.label} (${labelOwner.type})`],
    });
  }

  // -- Node scalars (§4.1) --
  const { mergedProperties, conflicts: propertyConflicts } = planProperties(s, a);
  const anchoredNow = resultIdentitySource === 'contact' && s.identitySource === 'label';
  const warnedAt = anchoredNow ? null : (s.warnedAt ?? a.warnedAt);
  const warnReason = anchoredNow ? null : (s.warnedAt ? s.warnReason : a.warnReason);
  const node: NodePlan = {
    mergedProperties,
    propertyConflicts,
    confidence: Math.max(s.confidence, a.confidence),
    decayClass: mostDurable(s.decayClass, a.decayClass),
    sensitivity: maxSensitivity(s.sensitivity, a.sensitivity),
    createdAt: minIso(s.createdAt, a.createdAt),
    lastConfirmedAt: maxIso(s.lastConfirmedAt, a.lastConfirmedAt),
    warnedAt,
    warnReason,
    identitySource: resultIdentitySource,
  };

  // -- Facts and edges (§4.3–4.4) --
  const facts = planFacts(survivor, absorbed);
  const edges = planEdges(survivor, absorbed);
  // The preview summary describes the default choices. The timestamp is irrelevant to counts.
  const defaultOps = buildFactOperations(facts, { facts: {}, nearDuplicateFacts: {} }, s.lastConfirmedAt);

  // -- Direction suggestion (§8) --
  let suggestedDirection: { swap: boolean; reason: string | null } = { swap: false, reason: null };
  if (absorbedIsPrincipal) {
    suggestedDirection = { swap: true, reason: `‘${a.label}’ is the principal’s own node.` };
  } else if (absorbed.contacts.length > 0 && s.type !== 'person' && s.type !== 'organization') {
    suggestedDirection = { swap: true, reason: `‘${a.label}’ has a contact record, which a ${s.type} node cannot hold.` };
  } else if (a.type === 'person' && absorbed.contacts.length > 0 && survivor.contacts.length === 0 && s.type !== 'person') {
    suggestedDirection = {
      swap: true,
      reason: `‘${a.label}’ is a person with a contact record; keeping ‘${s.label}’ would make the result a ${s.type} and lose that personhood.`,
    };
  }

  const aliases = computeAliases(s, a, 'survivor');

  const preview: MergePlan['preview'] = {
    dryRun: true,
    planToken: token,
    survivor: nodeSummary(survivor),
    absorbed: nodeSummary(absorbed),
    crossType: s.type !== a.type,
    suggestedDirection,
    result: {
      type: s.type,
      labels: { survivor: s.label, absorbed: a.label },
      defaultLabel: 'survivor',
      aliases: aliases.aliases,
      droppedAliases: aliases.droppedAliases,
      sensitivity: node.sensitivity,
      confidence: node.confidence,
      decayClass: node.decayClass,
      identitySource: node.identitySource,
    },
    blockers,
    warnings,
    conflicts: {
      properties: propertyConflicts,
      facts: facts.conflicts.map(c => ({
        id: c.id,
        attribute: c.attribute,
        survivor: factSummary(c.survivorFact),
        absorbed: factSummary(c.absorbedFact),
        default: c.default,
      })),
      nearDuplicateFacts: facts.nearDuplicates.map(n => ({
        id: n.id,
        survivor: factSummary(n.survivorFact),
        absorbed: factSummary(n.absorbedFact),
        similarity: n.similarity,
        default: 'merge' as const,
      })),
      contactFields: contacts.fieldConflicts.map((c: ContactFieldConflictPlan) => ({
        field: c.field,
        label: CONTACT_MERGE_FIELD_LABELS[c.field],
        survivorValue: c.survivorValue,
        absorbedValue: c.absorbedValue,
        default: 'survivor' as const,
      })),
      authOverrides: contacts.authOverrideConflicts.map((c: AuthOverrideConflictPlan) => ({
        permission: c.permission,
        survivorGranted: c.survivorGranted,
        absorbedGranted: c.absorbedGranted,
        default: 'survivor' as const,
      })),
    },
    contactPlan: contactPlanView(contacts, survivor),
    summary: summaryCounts(edges, defaultOps),
  };

  return { planToken: token, snapshot, preview, node, facts, edges, contacts };
}
