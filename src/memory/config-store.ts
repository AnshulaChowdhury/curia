// src/memory/config-store.ts
//
// KG-backed key-value store for system infrastructure and the config-store skill.
// Non-agent callers (EmailAdapter, ceo-inbox-list, …) use it directly; the skill
// handler delegates get/set/list here so exact-key semantics live in one place (#2252).
//
// Storage model:
//   Namespace anchor: type=concept, label="config:{namespace}"
//   Per-key facts on the anchor:
//     label=key, properties: { key, value, namespace, exact_key: true }, decayClass=permanent
//
// Writes use storeFact with exactKey: true so opaque config keys never merge via
// label embedding similarity. Same-key writes update in place; distinct keys always
// create separate facts. Soft rejections (result.stored === false) are logged and
// non-fatal for heartbeat use — the prior value remains valid.
//
// System writes use source `system:config-store`, which the validator exempts from
// the per-task rate limit (nothing resets a process-lifetime counter for it).

import type { EntityMemory } from './entity-memory.js';
import type { KgNode } from './types.js';
import type { Logger } from '../logger.js';

/** Fixed source for infrastructure callers — exempt from MemoryValidator rate limits. */
export const SYSTEM_CONFIG_SOURCE = 'system:config-store';

function anchorLabel(namespace: string): string {
  return `config:${namespace}`;
}

function confirmedAtMs(f: KgNode): number {
  return f.temporal?.lastConfirmedAt?.getTime() ?? 0;
}

/**
 * Pick the fact for a config key. Prefer properties.key; fall back to label only
 * when properties.key is absent (legacy / hand-crafted facts). When label and key
 * disagree after a historical semantic merge, properties.key wins — never return
 * a fact whose properties.key is a different string (#2252).
 */
export function matchConfigFact(facts: KgNode[], key: string): KgNode | undefined {
  const byPropKey = facts.filter((f) => (f.properties.key as string | undefined) === key);
  if (byPropKey.length > 0) {
    return byPropKey.sort((a, b) => confirmedAtMs(b) - confirmedAtMs(a))[0];
  }
  // Legacy: no properties.key on the node — match label, most recent first.
  const byLabel = facts.filter(
    (f) => f.properties.key === undefined && f.label === key,
  );
  return byLabel.sort((a, b) => confirmedAtMs(b) - confirmedAtMs(a))[0];
}

/**
 * List entries keyed for display. One row per logical key: prefers a fact that
 * has properties.key over a legacy label-only twin, then most-recently confirmed.
 */
export function listConfigEntries(facts: KgNode[]): Array<{ key: string; value: string }> {
  const byKey = new Map<string, KgNode>();
  for (const f of facts) {
    const key = (f.properties.key as string | undefined) ?? f.label;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
      continue;
    }
    const existingHasKey = typeof existing.properties.key === 'string';
    const incomingHasKey = typeof f.properties.key === 'string';
    if (incomingHasKey && !existingHasKey) {
      byKey.set(key, f);
    } else if (incomingHasKey === existingHasKey && confirmedAtMs(f) > confirmedAtMs(existing)) {
      byKey.set(key, f);
    }
  }
  return [...byKey.entries()].map(([key, f]) => ({
    key,
    value: f.properties.value as string,
  }));
}

export interface ConfigStoreSetOptions {
  /** Defaults to 0.9 for system callers; the skill passes 1.0. */
  confidence?: number;
  /** Defaults to SYSTEM_CONFIG_SOURCE. */
  source?: string;
  /** Defaults to SYSTEM_CONFIG_SOURCE for newly created anchors. */
  anchorSource?: string;
  /**
   * When true, skip warn/error logging here so a wrapping caller (the skill
   * handler) can own the single log line and avoid duplicates.
   */
  quiet?: boolean;
}

export class ConfigStore {
  constructor(
    private readonly entityMemory: EntityMemory,
    private readonly logger: Logger,
  ) {}

  /**
   * Read a stored value. Returns null when the namespace has never been written
   * to, or when the key does not exist within the namespace.
   *
   * Propagates infrastructure errors (DB down, KG unavailable, etc.) so callers
   * can distinguish "key not found" (null) from "read failed" (thrown error).
   */
  async get(namespace: string, key: string): Promise<string | null> {
    const facts = await this.loadNamespaceFacts(namespace);
    if (facts === null) return null;
    const fact = matchConfigFact(facts, key);
    if (!fact) return null;
    return (fact.properties.value as string) ?? null;
  }

  /**
   * List every entry in a namespace. Returns [] when the namespace has never been
   * written to. Used by the skill's retrieve-all path.
   */
  async list(namespace: string): Promise<Array<{ key: string; value: string }>> {
    const facts = await this.loadNamespaceFacts(namespace);
    if (facts === null) return [];
    return listConfigEntries(facts);
  }

  /**
   * Write or update a value. Soft storeFact rejection is logged (unless quiet)
   * and returned as `{ stored: false }` without throwing. Infrastructure errors
   * are logged (unless quiet) and rethrown.
   */
  async set(
    namespace: string,
    key: string,
    value: string,
    opts: ConfigStoreSetOptions = {},
  ): Promise<{ stored: boolean; action: string }> {
    const source = opts.source ?? SYSTEM_CONFIG_SOURCE;
    const confidence = opts.confidence ?? 0.9;
    const anchorSource = opts.anchorSource ?? SYSTEM_CONFIG_SOURCE;

    try {
      const anchor = await this.findOrCreateAnchor(namespace, key, anchorSource);

      const result = await this.entityMemory.storeFact({
        entityNodeId: anchor.id,
        label: key,
        properties: { key, value, namespace, exact_key: true },
        confidence,
        decayClass: 'permanent',
        source,
        exactKey: true,
      });

      if (!result.stored && !opts.quiet) {
        this.logger.warn(
          { namespace, key, action: result.action },
          'ConfigStore.set: storeFact rejected the write — prior value still in effect',
        );
      }

      return { stored: result.stored, action: result.action };
    } catch (err) {
      if (!opts.quiet) {
        this.logger.error({ err, namespace, key }, 'ConfigStore.set: failed to write value');
      }
      throw err;
    }
  }

  private async loadNamespaceFacts(namespace: string): Promise<KgNode[] | null> {
    const anchors = await this.entityMemory.findEntities(anchorLabel(namespace));
    if (anchors.length === 0) return null;
    const allFacts = await Promise.all(anchors.map((a) => this.entityMemory.getFacts(a.id)));
    return allFacts.flat();
  }

  /**
   * The anchor a write for `key` should go to. With one anchor (the normal case)
   * that is it. When the anchor-create race has left several same-label anchors,
   * write to the one that already holds the key — validateExactKey only searches
   * the anchor it is given, so picking another would create a twin that get()
   * and list() then read alongside the original. No match: first anchor.
   */
  private async findOrCreateAnchor(
    namespace: string,
    key: string,
    source: string,
  ): Promise<{ id: string }> {
    const label = anchorLabel(namespace);
    const existing = await this.entityMemory.findEntities(label);
    if (existing.length === 1) return existing[0]!;
    if (existing.length > 1) {
      const factsByAnchor = await Promise.all(
        existing.map(async (anchor) => ({ anchor, facts: await this.entityMemory.getFacts(anchor.id) })),
      );
      const match = matchConfigFact(factsByAnchor.flatMap((a) => a.facts), key);
      const owner = match
        ? factsByAnchor.find((a) => a.facts.some((f) => f.id === match.id))?.anchor
        : undefined;
      return owner ?? existing[0]!;
    }

    const { entity } = await this.entityMemory.createEntity({
      type: 'concept',
      label,
      properties: { category: 'config', namespace },
      source,
    });
    return entity;
  }
}
