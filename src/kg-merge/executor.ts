// executor.ts — run an execution plan on the merge transaction's client.
//
// Spec: docs/wip/2026-10-21-kg-node-merge-design.md §7 step 4. Everything here takes the
// one PoolClient that holds BEGIN and the row locks; nothing goes through the pool-based
// KnowledgeGraphStore / EntityMemory methods, which would escape the transaction.
//
// Order, and why:
//   1. contacts — kg_node_id re-points must land before the absorbed node is archived;
//   2. facts — shared links and dropped fact nodes go first, then the kept facts change
//      and the moved links are re-pointed;
//   3. edges — deletes (self-loops, collapsed duplicates) before any endpoint update, or
//      a moved edge would collide with its own duplicate on idx_kg_edges_unique;
//   4. archive the absorbed node — before the survivor update, because a same-type merge
//      that takes the absorbed label needs the absorbed row out of idx_kg_nodes_unique
//      first (the index is not deferrable);
//   5. survivor node update.

import type { DbPoolClient } from '../db/connection.js';
import type { ContactService } from '../contacts/contact-service.js';
import { countRepointedReferences } from '../contacts/contact-service.js';
import type { Logger } from '../logger.js';
import { NODE_COLUMNS, toApiKgNode, type PgNodeRow } from './snapshot.js';
import type { ApiKgNode, ExecutionPlan } from './types.js';

export interface ExecutorDeps {
  contactService: ContactService;
  logger: Logger;
}

export interface ExecutionOutcome {
  node: ApiKgNode;
  contactReferencesRepointed: number;
}

/** Re-point whichever endpoint of each edge is the absorbed node onto the survivor. */
const REPOINT_EDGES_SQL = `
  UPDATE kg_edges
  SET source_node_id = CASE WHEN source_node_id = $2::uuid THEN $3::uuid ELSE source_node_id END,
      target_node_id = CASE WHEN target_node_id = $2::uuid THEN $3::uuid ELSE target_node_id END
  WHERE id = ANY($1::uuid[])`;

export async function executeMerge(
  client: DbPoolClient,
  plan: ExecutionPlan,
  embedding: number[] | null,
  deps: ExecutorDeps,
): Promise<ExecutionOutcome> {
  const { survivorId, absorbedId } = plan;
  const log = deps.logger.child({ survivorId, absorbedId });

  // 1. Contacts.
  let contactReferencesRepointed = 0;
  for (const repoint of plan.contacts.repoints) {
    await client.query(
      `UPDATE contacts SET kg_node_id = $2, kind = $3, updated_at = now() WHERE id = $1`,
      [repoint.contactId, survivorId, repoint.kind],
    );
  }
  if (plan.contacts.survivingContactId && plan.contacts.mergedRow) {
    for (const merge of plan.contacts.merges) {
      const outcome = await deps.contactService.mergeContactRowsInTx(
        client,
        plan.contacts.survivingContactId,
        merge.secondaryId,
        plan.contacts.mergedRow,
        { overridesPreferSecondary: merge.overridesPreferSecondary },
      );
      contactReferencesRepointed += countRepointedReferences(outcome.references);
      log.debug({ secondaryId: merge.secondaryId, outcome }, 'kg-merge: contact folded');
    }
  }

  // 2. Facts.
  if (plan.facts.deleteLinkEdgeIds.length > 0) {
    await client.query(`DELETE FROM kg_edges WHERE id = ANY($1::uuid[])`, [plan.facts.deleteLinkEdgeIds]);
  }
  if (plan.facts.deleteFactIds.length > 0) {
    // type = 'fact' is a guard: this statement must never touch an entity node.
    // Their link edges cascade (kg_edges ON DELETE CASCADE).
    await client.query(
      `DELETE FROM kg_nodes WHERE id = ANY($1::uuid[]) AND type = 'fact'`,
      [plan.facts.deleteFactIds],
    );
  }
  for (const update of plan.facts.updates) {
    await client.query(
      `UPDATE kg_nodes
       SET confidence = $2, last_confirmed_at = $3, sensitivity = $4, properties = $5::jsonb
       WHERE id = $1 AND type = 'fact'`,
      [update.id, update.confidence, update.lastConfirmedAt, update.sensitivity, JSON.stringify(update.properties)],
    );
  }
  if (plan.facts.relinkEdgeIds.length > 0) {
    await client.query(REPOINT_EDGES_SQL, [plan.facts.relinkEdgeIds, absorbedId, survivorId]);
  }

  // 3. Edges.
  if (plan.edges.deleteEdgeIds.length > 0) {
    await client.query(`DELETE FROM kg_edges WHERE id = ANY($1::uuid[])`, [plan.edges.deleteEdgeIds]);
  }
  for (const collapse of plan.edges.collapses) {
    await client.query(
      `UPDATE kg_edges
       SET confidence = $2, last_confirmed_at = $3, decay_class = $4, properties = $5::jsonb
       WHERE id = $1`,
      [collapse.survivorEdgeId, collapse.confidence, collapse.lastConfirmedAt, collapse.decayClass, JSON.stringify(collapse.properties)],
    );
  }
  if (plan.edges.moveEdgeIds.length > 0) {
    await client.query(REPOINT_EDGES_SQL, [plan.edges.moveEdgeIds, absorbedId, survivorId]);
  }

  // Everything live on the absorbed node should have been moved or removed. A leftover
  // means the snapshot missed an edge — roll back rather than archive over it.
  const leftover = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM kg_edges
     WHERE archived_at IS NULL AND (source_node_id = $1 OR target_node_id = $1)`,
    [absorbedId],
  );
  const leftoverCount = Number.parseInt(leftover.rows[0]?.count ?? '0', 10);
  if (leftoverCount > 0) {
    log.error({ leftoverCount }, 'kg-merge: absorbed node still has live edges after the move — rolling back');
    throw new Error(`kg-merge: ${leftoverCount} live edge(s) left on the absorbed node ${absorbedId}`);
  }

  // 4. Archive the absorbed node as a tombstone (§4.5): label and type kept.
  await client.query(
    `UPDATE kg_nodes
     SET archived_at = now(), properties = properties || $2::jsonb
     WHERE id = $1`,
    [absorbedId, JSON.stringify({ merged_into: survivorId, merged_at: plan.mergedAt })],
  );

  // 5. Survivor node (§4.1). The embedding is replaced only when a new one was computed.
  const node = plan.node;
  const updated = await client.query<PgNodeRow>(
    `UPDATE kg_nodes
     SET label = $2, aliases = $3, properties = $4::jsonb, confidence = $5, decay_class = $6,
         sensitivity = $7, created_at = $8, last_confirmed_at = $9, warned_at = $10,
         warn_reason = $11, identity_source = $12,
         embedding = COALESCE($13::vector, embedding)
     WHERE id = $1
     RETURNING ${NODE_COLUMNS}`,
    [
      survivorId,
      node.label,
      node.aliases,
      JSON.stringify(node.properties),
      node.confidence,
      node.decayClass,
      node.sensitivity,
      node.createdAt,
      node.lastConfirmedAt,
      node.warnedAt,
      node.warnReason,
      node.identitySource,
      embedding ? `[${embedding.join(',')}]` : null,
    ],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new Error(`kg-merge: survivor node ${survivorId} vanished during the merge`);
  }

  return { node: toApiKgNode(row), contactReferencesRepointed };
}
