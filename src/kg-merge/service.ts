// service.ts — NodeMergeService: preview, apply and merge candidates for two KG nodes.
//
// Spec: docs/wip/2026-10-21-kg-node-merge-design.md §7–§9. The flow of apply():
//   1. snapshot without locks → plan → token check (fast 409);
//   2. resolutions validated against the plan (400 / 422);
//   3. new label embedded OUTSIDE the transaction (never hold row locks across an API call);
//   4. BEGIN → snapshot again under FOR UPDATE → token check → execute → COMMIT;
//   5. post-commit notifications and the kg.nodes_merged audit event — a failure there is
//      logged and never undoes the commit.

import type { DbPool } from '../db/connection.js';
import type { EventBus } from '../bus/bus.js';
import { createKgNodesMerged } from '../bus/events.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { TaskOriginator } from '../contacts/types.js';
import type { Logger } from '../logger.js';
import { embeddingStamp, type EmbeddingProfile, type EmbeddingPurpose } from '../memory/embedding-profiles.js';
import { isUuid } from '../util/uuid.js';
import { InvalidResolutionError, NodeNotFoundError, StalePreviewError } from './errors.js';
import { executeMerge, type ExecutionOutcome, type SurvivorEmbedding } from './executor.js';
import { planNodeMerge, planToken, type FactSimilarity } from './planner.js';
import { applyResolutions } from './resolve.js';
import { loadMergeSnapshot, NODE_COLUMNS, toApiKgNode, type PgNodeRow } from './snapshot.js';
import type {
  MergeCandidate,
  MergeCandidateReason,
  NodeMergePreview,
  NodeMergeResolutions,
  NodeMergeResult,
} from './types.js';

export const MAX_CANDIDATES = 20;
export const DEFAULT_CANDIDATES = 8;

/** The slice of EmbeddingService the merge uses: the live profile and a document embed. */
export interface Embedder {
  readonly profile: EmbeddingProfile;
  embed(text: string, purpose: EmbeddingPurpose): Promise<number[]>;
}

export interface NodeMergeServiceDeps {
  pool: DbPool;
  contactService: ContactService;
  bus: EventBus;
  logger: Logger;
  /**
   * The knowledge graph's embedding service, present when its boot gate passed (ADR-051).
   * Without it a label change keeps the old embedding, and neither near-duplicate facts nor
   * embedding candidates are offered: a score means nothing without its model's threshold.
   */
  embedder?: Embedder;
}

export interface ApplyNodeMergeInput {
  survivorId: string;
  absorbedId: string;
  planToken: string;
  resolutions: NodeMergeResolutions;
  /** Who asked — the console originator. Recorded on the audit event. */
  actor: TaskOriginator | null;
}

/** The public surface the HTTP route depends on (a fake implements it in route tests). */
export interface NodeMergeApi {
  preview(survivorId: string, absorbedId: string): Promise<NodeMergePreview>;
  apply(input: ApplyNodeMergeInput): Promise<NodeMergeResult>;
  candidates(nodeId: string, limit?: number): Promise<MergeCandidate[]>;
}

/**
 * An embedder's output is only written when it is a vector the kg_nodes.embedding column
 * accepts: an array of the profile's `dimensions` finite numbers. Anything else is treated
 * like a failed embed call (the survivor keeps its old embedding) rather than failing the merge.
 */
export function isUsableEmbedding(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value)
    && value.length === dimensions
    && value.every(v => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Validates and lower-cases the two ids. isUuid accepts upper case, but Postgres returns
 * uuid columns in canonical lower case and the snapshot looks rows up by id string — an
 * upper-case id would miss its own row and read as node_not_found.
 */
function validateIds(survivorId: string, absorbedId: string): { survivorId: string; absorbedId: string } {
  if (!isUuid(survivorId) || !isUuid(absorbedId)) {
    throw new InvalidResolutionError('invalid_request', 'survivorId and absorbedId must be valid UUIDs.');
  }
  const ids = { survivorId: survivorId.toLowerCase(), absorbedId: absorbedId.toLowerCase() };
  if (ids.survivorId === ids.absorbedId) {
    throw new InvalidResolutionError('invalid_request', 'survivorId and absorbedId must differ.');
  }
  return ids;
}

export class NodeMergeService implements NodeMergeApi {
  /** Fact near-duplicate scoring from the live profile, or undefined without an embedder. */
  private readonly factSimilarity: FactSimilarity | undefined;

  constructor(private readonly deps: NodeMergeServiceDeps) {
    const profile = deps.embedder?.profile;
    this.factSimilarity = profile
      ? { embeddingModel: embeddingStamp(profile), threshold: profile.thresholds.factDedup }
      : undefined;
  }

  async preview(rawSurvivorId: string, rawAbsorbedId: string): Promise<NodeMergePreview> {
    const { survivorId, absorbedId } = validateIds(rawSurvivorId, rawAbsorbedId);
    const snapshot = await loadMergeSnapshot(this.deps.pool, survivorId, absorbedId, { forUpdate: false });
    return planNodeMerge(snapshot, this.factSimilarity).preview;
  }

  async apply(input: ApplyNodeMergeInput): Promise<NodeMergeResult> {
    const { survivorId, absorbedId } = validateIds(input.survivorId, input.absorbedId);
    const log = this.deps.logger.child({ survivorId, absorbedId, component: 'kg-merge' });

    // 1–2. Plan from unlocked data; a changed graph fails fast, before any lock is taken.
    const snapshot = await loadMergeSnapshot(this.deps.pool, survivorId, absorbedId, { forUpdate: false });
    const plan = planNodeMerge(snapshot, this.factSimilarity);
    if (plan.planToken !== input.planToken) throw new StalePreviewError();
    const exec = applyResolutions(plan, input.resolutions);

    // 3. Embedding for a changed label, outside the transaction.
    const warnings: string[] = [];
    let embedding: SurvivorEmbedding | null = null;
    if (exec.node.labelChanged) {
      const embedder = this.deps.embedder;
      if (!embedder) {
        log.warn('kg-merge: no embedder configured — survivor keeps its old embedding after the rename');
        warnings.push('embedding_not_refreshed');
      } else {
        const { dimensions } = embedder.profile;
        try {
          // 'document': the purpose every stored label is embedded with (ADR-051).
          const candidate: unknown = await embedder.embed(exec.node.label, 'document');
          if (isUsableEmbedding(candidate, dimensions)) {
            embedding = { vector: candidate, model: embeddingStamp(embedder.profile) };
          } else {
            log.warn(
              { length: Array.isArray(candidate) ? candidate.length : null, expected: dimensions },
              'kg-merge: embedder returned an invalid vector — survivor keeps its old embedding',
            );
            warnings.push('embedding_not_refreshed');
          }
        } catch (err) {
          log.warn({ err }, 'kg-merge: re-embedding the new label failed — survivor keeps its old embedding');
          warnings.push('embedding_not_refreshed');
        }
      }
    }

    // 4. The transaction.
    let outcome: ExecutionOutcome;
    const client = await this.deps.pool.connect();
    // Set when ROLLBACK itself fails: the connection's transaction state is unknown, so it
    // is released with the error and the pool destroys it instead of handing it out again.
    let brokenConnection: Error | undefined;
    try {
      await client.query('BEGIN');
      const locked = await loadMergeSnapshot(client, survivorId, absorbedId, { forUpdate: true });
      if (planToken(locked, this.factSimilarity) !== plan.planToken) throw new StalePreviewError();
      outcome = await executeMerge(client, exec, embedding, { contactService: this.deps.contactService, logger: log });
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error({ err: rollbackErr }, 'kg-merge: ROLLBACK failed — discarding the connection');
        brokenConnection = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      if (err instanceof StalePreviewError || err instanceof NodeNotFoundError) {
        log.info({ code: err.code }, 'kg-merge: graph changed under the merge — rolled back, nothing written');
      } else {
        log.error({ err }, 'kg-merge: merge failed — rolled back, nothing written');
      }
      throw err;
    } finally {
      client.release(brokenConnection);
    }

    // 5. After commit. announceContactsMerged never throws: it logs its own callback
    // failures, and the identity refresh is fire-and-forget.
    const contacts = exec.contacts;
    const mergedAt = new Date(exec.mergedAt);
    if (contacts.survivingContactId && (contacts.mergedContactIds.length > 0 || contacts.survivingIsPrincipal)) {
      this.deps.contactService.announceContactsMerged(contacts.survivingContactId, contacts.mergedContactIds, mergedAt);
    }

    const summary = { ...exec.summary, contactReferencesRepointed: outcome.contactReferencesRepointed };
    const contactMerge = contacts.survivingContactId && contacts.action !== 'none'
      ? {
          survivingContactId: contacts.survivingContactId,
          mergedContactIds: contacts.mergedContactIds,
          repointedContactIds: contacts.repointedContactIds,
        }
      : null;

    try {
      await this.deps.bus.publish('system', createKgNodesMerged({
        survivorId,
        absorbedId,
        survivor: exec.survivor,
        absorbed: exec.absorbed,
        resultLabel: exec.node.label,
        crossType: exec.crossType,
        contactMerge: contacts.action === 'none'
          ? null
          : {
              survivingContactId: contacts.survivingContactId,
              mergedContactIds: contacts.mergedContactIds,
              repointedContactIds: contacts.repointedContactIds,
            },
        summary,
        resolutions: exec.resolutions,
        principalIdentitiesTransferred: contacts.principalIdentitiesTransferred,
        principalPrimaryFieldsFilled: contacts.principalPrimaryFieldsFilled,
        actor: input.actor,
        mergedAt: exec.mergedAt,
      }));
    } catch (err) {
      log.error({ err }, 'kg-merge: failed to publish kg.nodes_merged — audit trail may be incomplete (merge is committed)');
      warnings.push('audit_event_not_recorded');
    }

    log.info({ summary, contactMerge, warnings }, 'kg-merge: nodes merged');

    return {
      dryRun: false,
      survivorId,
      absorbedId,
      mergedAt: exec.mergedAt,
      node: outcome.node,
      summary,
      contactMerge,
      warnings,
    };
  }

  /**
   * Likely duplicates of a node, of any type (§8): label/alias equality in either direction
   * (score 1.0), then embedding neighbours at or above the profile's fuzzy ambiguity floor,
   * the score where entity resolution starts asking (ADR-051). Only vectors from the live
   * model are compared; without an embedder, none are.
   */
  async candidates(nodeId: string, limit: number = DEFAULT_CANDIDATES): Promise<MergeCandidate[]> {
    if (!isUuid(nodeId)) {
      throw new InvalidResolutionError('invalid_request', 'Node id must be a valid UUID.');
    }
    const cap = Math.max(1, Math.min(Math.trunc(limit), MAX_CANDIDATES));
    const { pool } = this.deps;
    const self = await pool.query<PgNodeRow>(`SELECT ${NODE_COLUMNS} FROM kg_nodes WHERE id = $1`, [nodeId]);
    const node = self.rows[0];
    if (!node || node.archived_at !== null) throw new NodeNotFoundError(nodeId);
    if (node.type === 'fact') return [];

    const names = [...new Set([node.label, ...(node.aliases ?? [])].map(n => n.trim().toLowerCase()).filter(n => n.length > 0))];
    const found = new Map<string, MergeCandidate>();

    const exact = await pool.query<PgNodeRow>(
      `SELECT ${NODE_COLUMNS} FROM kg_nodes
       WHERE archived_at IS NULL AND type <> 'fact' AND id <> $1
         AND (lower(label) = ANY($2::text[]) OR aliases && $2::text[])
       ORDER BY last_confirmed_at DESC, id
       LIMIT 50`,
      [nodeId, names],
    );
    const ownLabel = node.label.trim().toLowerCase();
    for (const row of exact.rows) {
      const reasons: MergeCandidateReason[] = [];
      if (row.label.trim().toLowerCase() === ownLabel) reasons.push('same_label');
      const theirNames = new Set([row.label, ...(row.aliases ?? [])].map(n => n.trim().toLowerCase()));
      const aliasHit = names.some(n => n !== ownLabel && theirNames.has(n))
        || (row.aliases ?? []).some(a => a.toLowerCase() === ownLabel);
      if (aliasHit || reasons.length === 0) reasons.push('alias_match');
      found.set(row.id, { node: toApiKgNode(row), score: 1, reasons });
    }

    const profile = this.deps.embedder?.profile;
    const model = profile ? embeddingStamp(profile) : null;
    if (profile && node.embedding && node.embedding_model === model) {
      // An exact scan, not the HNSW index. idx_kg_nodes_embedding covers every node, and the
      // index returns only its hnsw.ef_search (40) nearest before the WHERE clause runs. Facts
      // often name their entity; when 40 of them sit closer than a duplicate, the duplicate
      // is never suggested. Ordering by the computed similarity, rather
      // than by `embedding <=> $1`, keeps the index out; the scan is one console request and
      // computes distances for live non-fact nodes only.
      const similar = await pool.query<PgNodeRow & { similarity: number }>(
        `SELECT * FROM (
           SELECT ${NODE_COLUMNS}, 1 - (embedding <=> $1::vector) AS similarity
           FROM kg_nodes
           WHERE embedding IS NOT NULL AND embedding_model = $4
             AND archived_at IS NULL AND type <> 'fact' AND id <> $2
         ) scored
         WHERE similarity >= $5
         ORDER BY similarity DESC, id
         LIMIT $3`,
        [node.embedding, nodeId, cap * 3, model, profile.thresholds.fuzzyAmbiguityFloor],
      );
      for (const row of similar.rows) {
        const existing = found.get(row.id);
        if (existing) {
          existing.reasons.push('similar_embedding');
          continue;
        }
        found.set(row.id, {
          node: toApiKgNode(row),
          score: Math.round(row.similarity * 10_000) / 10_000,
          reasons: ['similar_embedding'],
        });
      }
    }

    return [...found.values()]
      .sort((x, y) => y.score - x.score || x.node.label.localeCompare(y.node.label) || x.node.id.localeCompare(y.node.id))
      .slice(0, cap);
  }
}
