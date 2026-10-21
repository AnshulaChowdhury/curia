// Pure logic for the knowledge-graph node-merge dialog (design §10.5).
//
// The console has no DOM test harness, so everything the dialog decides —
// default choices, what survives a re-preview or a swap, whether Merge is
// enabled, what the request body looks like, the plain-language summary —
// lives here and is unit-tested in kg-merge-utils.test.ts. MergeNodesDialog.tsx
// only renders state and wires events.

import type { ApiKgNode } from './kg-types.js';
import type {
  FactChoice,
  MergeBlocker,
  MergeCandidate,
  MergeCandidateReason,
  MergeNodeSummary,
  NearDuplicateChoice,
  NodeMergeErrorCode,
  NodeMergePreview,
  NodeMergeRequest,
  NodeMergeResolutions,
  NodeMergeResult,
  Side,
} from './kg-merge-types.js';

/** Mirrors MAX_ALIASES_PER_ENTITY in src/memory/entity-memory.ts. */
export const MAX_ALIASES = 10;
/** Debounce for the pick-step search box (design §10.2). */
export const SEARCH_DEBOUNCE_MS = 250;
export const CANDIDATE_LIMIT = 8;
export const SEARCH_LIMIT = 20;

export const STALE_PREVIEW_NOTICE = 'The graph changed while you were reviewing — please re-check.';

// ── Small formatting helpers ─────────────────────────────────────────────────

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Curly-quoted label, used in every user-facing sentence. */
export function quoted(label: string): string {
  return `‘${label || '(no label)'}’`;
}

/** "organization" → "Organization"; "slow_decay" → "Slow decay". */
export function typeLabel(type: string): string {
  if (!type) return 'Unknown';
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Display a property / conflict value. Strings as-is, everything else JSON. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (_err) {
    // Circular structures cannot come off the wire as JSON, but be total anyway.
    return String(value);
  }
}

export function formatConfidence(confidence: number | null | undefined): string {
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence.toFixed(2) : '—';
}

/** "2026-10-21" style date; "—" for missing or unparsable input. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

export function candidateReasonLabel(reason: MergeCandidateReason | string): string {
  switch (reason) {
    case 'same_label': return 'Same name';
    case 'alias_match': return 'Alias';
    case 'similar_embedding': return 'Similar';
    default: return reason;
  }
}

// ── Entry point (drawer button) ──────────────────────────────────────────────

/** The agent node carries properties.is_agent = 'true' (string or boolean). */
export function isAgentNode(node: Pick<ApiKgNode, 'properties'>): boolean {
  const flag = node.properties?.['is_agent'];
  return flag === true || flag === 'true';
}

export interface MergeAvailability {
  visible: boolean;
  disabled: boolean;
  reason: string | null;
}

/** Whether the drawer shows a Merge… button for this node, and if it is usable. */
export function mergeAvailability(node: Pick<ApiKgNode, 'type' | 'properties' | 'archived'>): MergeAvailability {
  if (node.type === 'fact') return { visible: false, disabled: true, reason: 'Fact nodes cannot be merged' };
  if (node.archived === true) {
    return { visible: true, disabled: true, reason: 'Archived nodes cannot be merged' };
  }
  if (isAgentNode(node)) {
    return { visible: true, disabled: true, reason: "The agent's own node cannot be merged" };
  }
  return { visible: true, disabled: false, reason: null };
}

// ── Pick step ────────────────────────────────────────────────────────────────

/** Up to `max` aliases to show on a row, plus how many were left out. */
export function displayAliases(aliases: readonly string[] | undefined, max = 3): { shown: string[]; more: number } {
  const list = (aliases ?? []).filter(a => typeof a === 'string' && a.trim() !== '');
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

/** A node can be picked as the other side when it is live, not a fact, and not the start node. */
export function isPickable(node: Pick<ApiKgNode, 'id' | 'type' | 'archived'>, currentId: string): boolean {
  return node.id !== currentId && node.type !== 'fact' && node.archived !== true;
}

/**
 * The pick-step search URL. `exclude_facts=true` keeps fact nodes from eating
 * the result limit; filterSearchResults still drops any that slip through.
 */
export function searchUrl(query: string): string {
  return `/api/kg/nodes?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&exclude_facts=true`;
}

/** Search results minus the current node, facts and duplicate ids. */
export function filterSearchResults(nodes: readonly ApiKgNode[], currentId: string): ApiKgNode[] {
  const seen = new Set<string>();
  const out: ApiKgNode[] = [];
  for (const n of nodes) {
    if (!isPickable(n, currentId) || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

/** Candidates minus the current node, facts and duplicates, best score first. */
export function filterCandidates(candidates: readonly MergeCandidate[], currentId: string): MergeCandidate[] {
  const seen = new Set<string>();
  const out: MergeCandidate[] = [];
  for (const c of candidates) {
    if (!isPickable(c.node, currentId) || seen.has(c.node.id)) continue;
    seen.add(c.node.id);
    out.push(c);
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── Review step: cards and banners ───────────────────────────────────────────

export interface MergeCardData {
  id: string;
  label: string;
  type: string;
  sensitivity: string | null;
  aliases: string[];
  /** e.g. "12 facts · 7 connections"; null before the preview arrives. */
  stats: string | null;
  /** e.g. ["Jane Doe · principal"]. */
  contacts: string[];
}

export function cardFromSummary(s: MergeNodeSummary): MergeCardData {
  return {
    id: s.id,
    label: s.label,
    type: s.type,
    sensitivity: s.sensitivity || null,
    aliases: s.aliases ?? [],
    stats: `${plural(s.factCount, 'fact')} · ${plural(s.edgeCount, 'connection')}`,
    contacts: (s.contacts ?? []).map(c => {
      const role = c.systemRole ?? (c.kind && c.kind !== 'person' ? c.kind : null);
      return role ? `${c.displayName} · ${role}` : c.displayName;
    }),
  };
}

export function cardFromNode(n: ApiKgNode): MergeCardData {
  return {
    id: n.id,
    label: n.label,
    type: n.type,
    sensitivity: n.sensitivity || null,
    aliases: n.aliases ?? [],
    stats: null,
    contacts: [],
  };
}

/**
 * The card for `id`, preferring the preview's summary (richer) and falling
 * back to a node we already hold. Lets the cards swap instantly while the
 * swapped preview is still loading.
 */
export function cardFor(
  id: string,
  preview: NodeMergePreview | null,
  known: readonly ApiKgNode[],
): MergeCardData | null {
  if (preview?.survivor.id === id) return cardFromSummary(preview.survivor);
  if (preview?.absorbed.id === id) return cardFromSummary(preview.absorbed);
  const node = known.find(n => n.id === id);
  return node ? cardFromNode(node) : null;
}

/** "‘Acme Summit’ (Event) will become part of ‘Acme’ (Organization). The result is an Organization." */
export function crossTypeBanner(preview: NodeMergePreview): string | null {
  if (!preview.crossType) return null;
  const { survivor, absorbed } = preview;
  return `${quoted(absorbed.label)} (${typeLabel(absorbed.type)}) will become part of `
    + `${quoted(survivor.label)} (${typeLabel(survivor.type)}). `
    + `The result is ${articleFor(preview.result.type)} ${typeLabel(preview.result.type)}.`;
}

function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** "Suggested: keep ‘X’ instead — <reason>." or null when no swap is suggested. */
export function suggestionText(preview: NodeMergePreview): string | null {
  if (!preview.suggestedDirection.swap) return null;
  const reason = preview.suggestedDirection.reason?.trim();
  const base = `Suggested: keep ${quoted(preview.absorbed.label)} instead`;
  return reason ? `${base} — ${reason}` : `${base}.`;
}

// ── Resolutions ──────────────────────────────────────────────────────────────

const SIDES: readonly Side[] = ['survivor', 'absorbed'];
const FACT_CHOICES: readonly FactChoice[] = ['survivor', 'absorbed', 'both'];
const NEAR_CHOICES: readonly NearDuplicateChoice[] = ['merge', 'keep_both'];

function isSide(v: unknown): v is Side {
  return SIDES.includes(v as Side);
}

/**
 * The preview's pre-selected answer to every conflict (acknowledgements
 * excluded). A default label the server would reject falls back to the
 * survivor's.
 */
export function defaultResolutions(preview: NodeMergePreview): NodeMergeResolutions {
  const c = preview.conflicts;
  const defaultLabel = preview.result.defaultLabel;
  return {
    label: isLabelAllowed(preview, defaultLabel) ? defaultLabel : 'survivor',
    properties: Object.fromEntries(c.properties.map(p => [p.key, p.default])),
    facts: Object.fromEntries(c.facts.map(f => [f.id, f.default])),
    nearDuplicateFacts: Object.fromEntries(c.nearDuplicateFacts.map(n => [n.id, n.default])),
    contactFields: Object.fromEntries(c.contactFields.map(f => [f.field, f.default])),
    authOverrides: Object.fromEntries(c.authOverrides.map(a => [a.permission, a.default])),
  };
}

function pick<T extends string>(
  prev: Record<string, string> | undefined,
  ids: readonly string[],
  allowed: readonly T[],
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!prev) return out;
  for (const id of ids) {
    const v = prev[id];
    if (v !== undefined && allowed.includes(v as T)) out[id] = v as T;
  }
  return out;
}

/**
 * Only the choices in `prev` that still make sense for `preview`: the conflict
 * still exists (same deterministic id) and the value is a legal option. The
 * label choice survives only when the two labels still differ and the chosen
 * one is still allowed (see isLabelAllowed).
 */
export function retainValidChoices(prev: NodeMergeResolutions, preview: NodeMergePreview): NodeMergeResolutions {
  const c = preview.conflicts;
  const out: NodeMergeResolutions = {
    properties: pick(prev.properties, c.properties.map(p => p.key), SIDES),
    facts: pick(prev.facts, c.facts.map(f => f.id), FACT_CHOICES),
    nearDuplicateFacts: pick(prev.nearDuplicateFacts, c.nearDuplicateFacts.map(n => n.id), NEAR_CHOICES),
    contactFields: pick(prev.contactFields, c.contactFields.map(f => f.field), SIDES),
    authOverrides: pick(prev.authOverrides, c.authOverrides.map(a => a.permission), SIDES),
  };
  if (isSide(prev.label) && labelsDiffer(preview) && isLabelAllowed(preview, prev.label)) out.label = prev.label;
  return out;
}

/**
 * The effective resolutions: the preview's defaults, overlaid with whichever
 * of the user's earlier choices are still valid (design §10.3 — a re-preview
 * after a 409 keeps the user's choices whose ids still exist).
 */
export function mergeResolutions(prev: NodeMergeResolutions, preview: NodeMergePreview): NodeMergeResolutions {
  const d = defaultResolutions(preview);
  const kept = retainValidChoices(prev, preview);
  return {
    label: kept.label ?? d.label,
    properties: { ...d.properties, ...kept.properties },
    facts: { ...d.facts, ...kept.facts },
    nearDuplicateFacts: { ...d.nearDuplicateFacts, ...kept.nearDuplicateFacts },
    contactFields: { ...d.contactFields, ...kept.contactFields },
    authOverrides: { ...d.authOverrides, ...kept.authOverrides },
  };
}

function flip(side: Side): Side {
  return side === 'survivor' ? 'absorbed' : 'survivor';
}

function flipRecord(r: Record<string, Side> | undefined): Record<string, Side> | undefined {
  if (!r) return undefined;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, flip(v)]));
}

/** `fact:<a>:<b>` → `fact:<b>:<a>`; ids of any other shape are returned unchanged. */
export function swapConflictId(id: string): string {
  const parts = id.split(':');
  if (parts.length !== 3) return id;
  const [prefix, s, a] = parts as [string, string, string];
  return `${prefix}:${a}:${s}`;
}

/**
 * Translate the user's explicit choices to the swapped direction, so a chosen
 * *value* stays chosen: "keep the absorbed side's title" becomes "keep the
 * survivor's title". Conflict ids that embed the direction are reversed.
 * Acknowledgements are dropped — warnings mean something else once swapped.
 */
export function swapResolutions(choices: NodeMergeResolutions): NodeMergeResolutions {
  const out: NodeMergeResolutions = {};
  if (choices.label) out.label = flip(choices.label);
  const properties = flipRecord(choices.properties);
  if (properties) out.properties = properties;
  const contactFields = flipRecord(choices.contactFields);
  if (contactFields) out.contactFields = contactFields;
  const authOverrides = flipRecord(choices.authOverrides);
  if (authOverrides) out.authOverrides = authOverrides;
  if (choices.facts) {
    out.facts = Object.fromEntries(Object.entries(choices.facts).map(([id, v]) =>
      [swapConflictId(id), v === 'both' ? 'both' : flip(v)]));
  }
  if (choices.nearDuplicateFacts) {
    out.nearDuplicateFacts = Object.fromEntries(Object.entries(choices.nearDuplicateFacts).map(([id, v]) =>
      [swapConflictId(id), v]));
  }
  return out;
}

/** Number of conflicts the user reviews (the label choice is not a conflict). */
export function conflictCount(preview: NodeMergePreview): number {
  const c = preview.conflicts;
  return c.properties.length + c.facts.length + c.nearDuplicateFacts.length
    + c.contactFields.length + c.authOverrides.length;
}

// ── Acknowledgements and the Merge gate ─────────────────────────────────────

/** Codes of requires-ack warnings not yet acknowledged (deduplicated, in order). */
export function missingAcknowledgements(preview: NodeMergePreview, acks: readonly string[]): string[] {
  const have = new Set(acks);
  const missing: string[] = [];
  for (const w of preview.warnings) {
    if (w.requiresAck && !have.has(w.code) && !missing.includes(w.code)) missing.push(w.code);
  }
  return missing;
}

export function canApply(preview: NodeMergePreview, acks: readonly string[]): boolean {
  return preview.blockers.length === 0 && missingAcknowledgements(preview, acks).length === 0;
}

/** Why Merge is disabled, for the footer hint; null when it is enabled. */
export function applyHint(preview: NodeMergePreview, acks: readonly string[]): string | null {
  if (preview.blockers.length > 0) {
    return preview.blockers.length === 1 ? 'Blocked — see the issue above' : 'Blocked — see the issues above';
  }
  const missing = missingAcknowledgements(preview, acks).length;
  if (missing > 0) return `Confirm ${plural(missing, 'warning')} to continue`;
  return null;
}

/**
 * Acknowledgements that still hold after a re-preview: the warning is still
 * there, still requires an ack, and says the same thing (message and details).
 * A principal-identity transfer that now lists a new identity must be re-ticked.
 */
export function retainAcknowledgements(
  acks: readonly string[],
  prev: NodeMergePreview,
  next: NodeMergePreview,
): string[] {
  const fingerprint = (w: NodeMergePreview['warnings'][number]) =>
    JSON.stringify([w.message, w.details ?? []]);
  return acks.filter(code => {
    const before = prev.warnings.find(w => w.code === code);
    const after = next.warnings.find(w => w.code === code && w.requiresAck);
    return !!before && !!after && fingerprint(before) === fingerprint(after);
  });
}

export function toggleAcknowledgement(acks: readonly string[], code: string, checked: boolean): string[] {
  const without = acks.filter(a => a !== code);
  return checked ? [...without, code] : without;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export function buildPreviewRequest(survivorId: string, absorbedId: string): NodeMergeRequest {
  return { survivorId, absorbedId, dryRun: true };
}

function nonEmpty<T>(r: Record<string, T> | undefined): Record<string, T> | undefined {
  return r && Object.keys(r).length > 0 ? r : undefined;
}

/**
 * The apply body. Sends an explicit answer for every conflict in the preview
 * (defaults included) so what the user saw is exactly what is applied, and
 * only the acknowledgements of warnings the preview actually raised.
 */
export function buildApplyRequest(
  preview: NodeMergePreview,
  resolutions: NodeMergeResolutions,
  acks: readonly string[],
): NodeMergeRequest {
  const r = mergeResolutions(resolutions, preview);
  const ackable = new Set(preview.warnings.filter(w => w.requiresAck).map(w => w.code));
  const acknowledgements = [...new Set(acks)].filter(a => ackable.has(a));
  const out: NodeMergeResolutions = {};
  if (r.label) out.label = r.label;
  const properties = nonEmpty(r.properties);
  if (properties) out.properties = properties;
  const facts = nonEmpty(r.facts);
  if (facts) out.facts = facts;
  const nearDuplicateFacts = nonEmpty(r.nearDuplicateFacts);
  if (nearDuplicateFacts) out.nearDuplicateFacts = nearDuplicateFacts;
  const contactFields = nonEmpty(r.contactFields);
  if (contactFields) out.contactFields = contactFields;
  const authOverrides = nonEmpty(r.authOverrides);
  if (authOverrides) out.authOverrides = authOverrides;
  if (acknowledgements.length > 0) out.acknowledgements = acknowledgements;
  return {
    survivorId: preview.survivor.id,
    absorbedId: preview.absorbed.id,
    dryRun: false,
    planToken: preview.planToken,
    resolutions: out,
  };
}

// ── Name and aliases ─────────────────────────────────────────────────────────

export function labelsDiffer(preview: NodeMergePreview): boolean {
  return preview.result.labels.survivor !== preview.result.labels.absorbed;
}

/**
 * Another live node of the result's type already carries the absorbed label,
 * so the server would reject it as the merged name (apply → 422 blocker
 * `label_collision`). The preview flags this as an info warning.
 */
export function hasLabelCollision(preview: NodeMergePreview): boolean {
  return preview.warnings.some(w => w.code === 'label_collision');
}

/** Whether `side`'s label may be chosen. The survivor keeps its own label, so it is always allowed. */
export function isLabelAllowed(preview: NodeMergePreview, side: Side): boolean {
  return side === 'survivor' || !hasLabelCollision(preview);
}

/** Why the absorbed label is disabled, for the Name section; null when it is allowed. */
export function labelCollisionReason(preview: NodeMergePreview): string | null {
  if (isLabelAllowed(preview, 'absorbed')) return null;
  const type = typeLabel(preview.result.type).toLowerCase();
  return `Another ${type} is already called ${quoted(preview.result.labels.absorbed)}.`;
}

function normAlias(a: string): string {
  return a.trim().toLowerCase();
}

/**
 * The aliases the result will carry for a given label choice (§4.1): survivor
 * aliases, the unchosen label, absorbed aliases — lower-cased, de-duplicated,
 * minus the final label, capped at MAX_ALIASES. For the default label the
 * server's own computation is returned verbatim.
 */
export function resultAliases(preview: NodeMergePreview, label: Side): { aliases: string[]; dropped: string[] } {
  if (label === preview.result.defaultLabel) {
    return { aliases: preview.result.aliases, dropped: preview.result.droppedAliases };
  }
  const { labels } = preview.result;
  const finalLabel = normAlias(label === 'survivor' ? labels.survivor : labels.absorbed);
  const unchosen = label === 'survivor' ? labels.absorbed : labels.survivor;
  const pool = [...preview.survivor.aliases, unchosen, ...preview.absorbed.aliases];
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of pool) {
    const a = normAlias(raw);
    if (!a || a === finalLabel || seen.has(a)) continue;
    seen.add(a);
    all.push(a);
  }
  return { aliases: all.slice(0, MAX_ALIASES), dropped: all.slice(MAX_ALIASES) };
}

// ── Contacts ─────────────────────────────────────────────────────────────────

function findContact(preview: NodeMergePreview, id: string | null) {
  if (!id) return null;
  return [...preview.survivor.contacts, ...preview.absorbed.contacts].find(c => c.id === id) ?? null;
}

function contactName(preview: NodeMergePreview, id: string | null): string | null {
  return findContact(preview, id)?.displayName ?? null;
}

/** " (kind: organization)" when the plan changes the kind of at least one contact. */
function kindChangeSuffix(preview: NodeMergePreview, ids: readonly (string | null)[]): string {
  const kind = preview.contactPlan.resultingKind;
  if (!kind) return '';
  const changes = ids.some(id => {
    const c = findContact(preview, id);
    return !!c && c.kind !== kind;
  });
  return changes ? ` (kind: ${kind})` : '';
}

function joinQuoted(names: string[]): string {
  const q = names.map(quoted);
  if (q.length <= 1) return q.join('');
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/**
 * One sentence describing what happens to the contact records, or null when
 * nothing does. E.g. "‘Jane Doe’ and ‘J. Doe’ will become one contact."
 */
export function contactPlanSentence(preview: NodeMergePreview): string | null {
  const plan = preview.contactPlan;
  const survivorLabel = quoted(preview.survivor.label);
  if (plan.action === 'merge') {
    const ids = [plan.survivingContactId, ...plan.mergedContactIds];
    const names = ids.map(id => contactName(preview, id)).filter((n): n is string => !!n);
    const base = names.length >= 2
      ? `${joinQuoted(names)} will become one contact`
      : `${plural(plan.mergedContactIds.length + 1, 'contact')} will become one`;
    return `${base}${kindChangeSuffix(preview, ids)}.`;
  }
  if (plan.action === 'repoint') {
    const names = plan.repointedContactIds.map(id => contactName(preview, id)).filter((n): n is string => !!n);
    const n = plan.repointedContactIds.length;
    const who = names.length === n && n > 0 ? joinQuoted(names) : plural(n, 'contact');
    let sentence = `${who} will now link to ${survivorLabel}${kindChangeSuffix(preview, plan.repointedContactIds)}.`;
    if (preview.survivor.type === 'organization' && preview.survivor.contacts.length + n > 1) {
      sentence += ' Merge duplicate contacts on the Contacts page.';
    }
    return sentence;
  }
  return null;
}

/** Whether the dialog needs a Contact record section at all. */
export function hasContactSection(preview: NodeMergePreview): boolean {
  return preview.contactPlan.action !== 'none'
    || preview.conflicts.contactFields.length > 0
    || preview.conflicts.authOverrides.length > 0;
}

// ── What happens ─────────────────────────────────────────────────────────────

/** Plain-language summary of the merge, one short clause per line (§10.2). */
export function summaryLines(preview: NodeMergePreview): string[] {
  const { summary: s, result, survivor, absorbed, contactPlan } = preview;
  const lines: string[] = [];
  if (s.factsMoved > 0) lines.push(`${plural(s.factsMoved, 'fact')} ${s.factsMoved === 1 ? 'moves' : 'move'}`);
  if (s.factsCollapsed > 0) lines.push(`${plural(s.factsCollapsed, 'duplicate fact')} combined`);
  if (s.edgesMoved > 0) {
    lines.push(`${plural(s.edgesMoved, 'connection')} ${s.edgesMoved === 1 ? 'moves' : 'move'}`);
  }
  if (s.edgesCollapsed > 0) lines.push(`${plural(s.edgesCollapsed, 'duplicate connection')} combined`);
  if (s.edgesDropped === 1) lines.push('the connection between these two is removed');
  else if (s.edgesDropped > 1) lines.push(`the ${s.edgesDropped} connections between these two are removed`);
  if (preview.crossType) lines.push(`the result is ${articleFor(result.type)} ${typeLabel(result.type)}`);
  if (result.sensitivity && result.sensitivity !== survivor.sensitivity) {
    lines.push(`sensitivity becomes ${result.sensitivity}`);
  }
  if (result.decayClass && result.decayClass !== survivor.decayClass) {
    lines.push(`decay class becomes ${typeLabel(result.decayClass).toLowerCase()}`);
  }
  if (typeof result.confidence === 'number' && result.confidence > survivor.confidence) {
    lines.push(`confidence rises to ${formatConfidence(result.confidence)}`);
  }
  if (contactPlan.action === 'merge') {
    lines.push(`${plural(contactPlan.mergedContactIds.length + 1, 'contact')} become one`);
  } else if (contactPlan.action === 'repoint' && contactPlan.repointedContactIds.length > 0) {
    lines.push(`${plural(contactPlan.repointedContactIds.length, 'contact')} relinked`);
  }
  if (result.identitySource !== survivor.identitySource && result.identitySource === 'contact') {
    lines.push('identity now follows the contact record');
  }
  lines.push(`${quoted(absorbed.label)} is archived (not deleted) and points to the result`);
  return lines;
}

// ── Footer ───────────────────────────────────────────────────────────────────

export function applyButtonLabel(preview: NodeMergePreview, pending: boolean): string {
  if (pending) return 'Merging…';
  const n = conflictCount(preview);
  const base = `Merge into ${quoted(preview.survivor.label)}`;
  return n > 0 ? `${base} (${plural(n, 'conflict')} reviewed)` : base;
}

// ── Responses and errors ─────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Minimal structural check of a dry-run response before the dialog renders it. */
export function isNodeMergePreview(body: unknown): body is NodeMergePreview {
  if (!isRecord(body) || body['dryRun'] !== true || typeof body['planToken'] !== 'string') return false;
  const conflicts = body['conflicts'];
  return isRecord(body['survivor']) && isRecord(body['absorbed']) && isRecord(body['result'])
    && isRecord(body['contactPlan']) && isRecord(body['summary'])
    && Array.isArray(body['blockers']) && Array.isArray(body['warnings'])
    && isRecord(conflicts)
    && ['properties', 'facts', 'nearDuplicateFacts', 'contactFields', 'authOverrides']
      .every(k => Array.isArray(conflicts[k]));
}

export function isNodeMergeResult(body: unknown): body is NodeMergeResult {
  return isRecord(body) && body['dryRun'] === false
    && typeof body['survivorId'] === 'string' && typeof body['absorbedId'] === 'string'
    && isRecord(body['node']);
}

/**
 * `unavailable`: the server has no merge service — nothing to retry.
 * `unknown`: the apply request may or may not have committed (network error,
 * gateway error, unreadable body) — the dialog must not present it as a clean
 * failure.
 */
export type MergeErrorKind = 'stale' | 'blocked' | 'not_found' | 'invalid' | 'unavailable' | 'unknown' | 'server';

export interface MergeError {
  kind: MergeErrorKind;
  code: NodeMergeErrorCode | null;
  message: string;
  blockers: MergeBlocker[];
}

export const MERGE_UNAVAILABLE_MESSAGE = 'Node merging isn’t available on this server.';
export const APPLY_OUTCOME_UNKNOWN_MESSAGE = 'We couldn’t confirm whether the merge finished. Reload to check.';
export const LABEL_COLLISION_MESSAGE = 'That name is already taken. Choose the other name, then merge again.';

const KNOWN_CODES: readonly NodeMergeErrorCode[] = [
  'invalid_request', 'ack_required', 'unknown_resolution', 'node_not_found', 'stale_preview', 'blocked', 'node_merged',
  'unavailable',
];

/** A 422 whose only problem is the chosen name: switching the Name radio fixes it. */
export function isLabelCollisionBlock(error: Pick<MergeError, 'kind' | 'blockers'>): boolean {
  return error.kind === 'blocked' && error.blockers.length > 0
    && error.blockers.every(b => b.code === 'label_collision');
}

/** Whether "Try again" can help. Blocked, missing, unavailable and unknown-outcome errors cannot. */
export function isRetryable(error: Pick<MergeError, 'kind'>): boolean {
  return error.kind === 'server' || error.kind === 'invalid' || error.kind === 'stale';
}

/** Normalise a non-2xx merge response into something the dialog can render. */
export function classifyMergeError(status: number, body: unknown): MergeError {
  const rec = isRecord(body) ? body : {};
  const rawCode = rec['code'];
  const code = KNOWN_CODES.includes(rawCode as NodeMergeErrorCode) ? rawCode as NodeMergeErrorCode : null;
  const serverMessage = typeof rec['error'] === 'string' && rec['error'].trim() ? rec['error'] : null;
  const blockers = Array.isArray(rec['blockers'])
    ? (rec['blockers'] as unknown[]).filter((b): b is MergeBlocker =>
      isRecord(b) && typeof b['code'] === 'string' && typeof b['message'] === 'string')
    : [];
  if (code === 'unavailable') {
    return { kind: 'unavailable', code, message: MERGE_UNAVAILABLE_MESSAGE, blockers };
  }
  if (status === 409 || code === 'stale_preview') {
    return { kind: 'stale', code, message: STALE_PREVIEW_NOTICE, blockers };
  }
  if (status === 422 || code === 'blocked') {
    const blocked: MergeError = { kind: 'blocked', code, message: serverMessage ?? 'This merge is blocked.', blockers };
    return isLabelCollisionBlock(blocked) ? { ...blocked, message: LABEL_COLLISION_MESSAGE } : blocked;
  }
  if (status === 404) {
    return {
      kind: 'not_found', code,
      message: serverMessage ?? 'One of the nodes no longer exists — it may have been merged or archived.',
      blockers,
    };
  }
  if (status === 400) {
    const fallback = code === 'ack_required'
      ? 'Please confirm every warning before merging.'
      : 'The merge request was rejected.';
    return { kind: 'invalid', code, message: serverMessage ?? fallback, blockers };
  }
  return { kind: 'server', code, message: serverMessage ?? `Merge failed (HTTP ${status}).`, blockers };
}

/** The apply request's outcome is unknown: it may have committed. */
export function outcomeUnknownError(): MergeError {
  return { kind: 'unknown', code: null, message: APPLY_OUTCOME_UNKNOWN_MESSAGE, blockers: [] };
}

/**
 * Classify a non-2xx response to the *apply* request. `body` is the parsed
 * JSON body, or null when there was none or it was not JSON.
 *
 * A gateway error (502, 504, or a 503 that is not the server's own
 * `unavailable`) or a body that is not the server's JSON means the request may
 * have reached the server and committed, so the outcome is reported as
 * unknown rather than as a failure. A network error (fetch rejects) is unknown
 * too; see outcomeUnknownError.
 */
export function classifyApplyError(status: number, body: unknown): MergeError {
  if (!isRecord(body)) return outcomeUnknownError();
  if (status === 502 || status === 504) return outcomeUnknownError();
  if (status === 503 && body['code'] !== 'unavailable') return outcomeUnknownError();
  return classifyMergeError(status, body);
}

/**
 * The survivor id from a GET /api/kg/graph 404 for a merged-away node
 * (`{ code: 'node_merged', mergedInto }`), or null for any other 404.
 * `label` is read when the server includes it, for the notice text.
 */
export function mergedIntoFrom(body: unknown): { mergedInto: string; label: string | null } | null {
  if (!isRecord(body) || body['code'] !== 'node_merged') return null;
  const target = body['mergedInto'];
  if (typeof target !== 'string' || target.trim() === '') return null;
  const label = typeof body['label'] === 'string' && body['label'].trim() ? body['label'] : null;
  return { mergedInto: target, label };
}

export function mergedIntoNotice(label: string | null): string {
  return label ? `${quoted(label)} was merged into this node.` : 'The node you opened was merged into this one.';
}

export function mergeSuccessMessage(absorbedLabel: string, survivorLabel: string): string {
  return `Merged ${quoted(absorbedLabel)} into ${quoted(survivorLabel)}.`;
}

/** Friendly text for a post-commit result warning; unknown codes are shown raw. */
export function mergeResultWarningText(code: string): string {
  switch (code) {
    case 'embedding_not_refreshed':
      return 'The new name may take a while to show up in similarity suggestions.';
    case 'audit_event_not_recorded':
      return 'The audit log entry could not be written — check the server logs.';
    case 'identity_refresh_failed':
      return 'A restart may be needed for the principal’s identities to refresh.';
    default:
      return code;
  }
}

/** The success banner's notes: one line per distinct result warning, in order. */
export function mergeResultNotes(warnings: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const w of warnings ?? []) {
    if (typeof w !== 'string' || w.trim() === '') continue;
    const text = mergeResultWarningText(w);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** The sidebar list after a merge: the absorbed node gone, the survivor refreshed in place. */
export function applyMergeToNodeList<T extends { id: string }>(
  nodes: readonly T[],
  result: Pick<NodeMergeResult, 'absorbedId' | 'survivorId'> & { node: T },
): T[] {
  return nodes
    .filter(n => n.id !== result.absorbedId)
    .map(n => (n.id === result.survivorId ? result.node : n));
}
