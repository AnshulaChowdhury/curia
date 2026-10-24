// scripts/repair-config-store-labels.ts
//
// One-off repair for config-store facts whose label diverged from properties.key
// after semantic dedup merged similar keys (#2252).
//
// What it fixes:
//   UPDATE kg_nodes SET label = properties->>'key', embedding = NULL, embedding_model = NULL
//   for fact nodes hanging off a config:<namespace> anchor where
//   label IS DISTINCT FROM properties->>'key'.
//   Clearing the embedding avoids leaving a vector for the old label (reembed:kg
//   would skip these rows because embedding_model is unchanged). exactKey writes
//   do not need the vector; a later optional reembed can refill if desired.
//
// What it cannot fix:
//   Values overwritten by the merge are gone from the graph. The script lists
//   each mismatched row and any duplicate (anchor, key) groups so an operator
//   can see remaining corruption.
//
// Dry-run (default): report only. Pass --apply to write.
// Does NOT bump last_confirmed_at — that would flip the recency tiebreak toward
// realigned stale twins when duplicate-key facts remain.
//
// Run:  pnpm run repair:config-store-labels
//       pnpm run repair:config-store-labels -- --apply

import { pathToFileURL } from 'node:url';
import pg from 'pg';
import pino from 'pino';

const logger = pino({ name: 'repair-config-store-labels' });
const { Pool } = pg;

/** Minimal structural type so tests can pass a mock without the full pg.Pool shape. */
export type PoolLike = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export interface MismatchedConfigFact {
  id: string;
  /** All config anchors this fact is linked to (deduped). */
  anchorLabels: string[];
  label: string;
  key: string;
  valuePreview: string;
}

export interface DuplicateKeyGroup {
  anchorLabel: string;
  key: string;
  factIds: string[];
  labels: string[];
}

export interface RepairResult {
  dryRun: boolean;
  mismatched: MismatchedConfigFact[];
  duplicates: DuplicateKeyGroup[];
  /** Rows updated when dryRun is false; always 0 in dry-run. */
  updatedCount: number;
}

/**
 * One row per fact id. Aggregates anchors so a fact linked to duplicate
 * config:ns anchors (anchor-create race) is not double-counted.
 */
export const LIST_MISMATCHED_SQL = `
  SELECT
    f.id,
    array_agg(DISTINCT a.label ORDER BY a.label) AS anchor_labels,
    f.label,
    f.properties->>'key' AS key,
    left(coalesce(f.properties->>'value', ''), 120) AS value_preview
  FROM kg_nodes f
  JOIN kg_edges e
    ON e.archived_at IS NULL
   AND (e.source_node_id = f.id OR e.target_node_id = f.id)
  JOIN kg_nodes a
    ON a.id = CASE
         WHEN e.source_node_id = f.id THEN e.target_node_id
         ELSE e.source_node_id
       END
  WHERE f.type = 'fact'
    AND f.archived_at IS NULL
    AND a.type = 'concept'
    AND a.archived_at IS NULL
    AND a.label LIKE 'config:%'
    AND f.properties ? 'key'
    AND f.label IS DISTINCT FROM f.properties->>'key'
  GROUP BY f.id, f.label, f.properties
  ORDER BY min(a.label), f.properties->>'key', f.id
`;

/**
 * Duplicate (anchor, key) groups — remaining corruption after label realign.
 * Does not bump last_confirmed_at; operators decide which twin to keep.
 */
export const LIST_DUPLICATE_KEYS_SQL = `
  SELECT
    a.label AS anchor_label,
    f.properties->>'key' AS key,
    array_agg(DISTINCT f.id::text) AS fact_ids,
    array_agg(DISTINCT f.label) AS labels
  FROM kg_nodes f
  JOIN kg_edges e
    ON e.archived_at IS NULL
   AND (e.source_node_id = f.id OR e.target_node_id = f.id)
  JOIN kg_nodes a
    ON a.id = CASE
         WHEN e.source_node_id = f.id THEN e.target_node_id
         ELSE e.source_node_id
       END
  WHERE f.type = 'fact'
    AND f.archived_at IS NULL
    AND a.type = 'concept'
    AND a.archived_at IS NULL
    AND a.label LIKE 'config:%'
    AND f.properties ? 'key'
  GROUP BY a.label, f.properties->>'key'
  HAVING count(DISTINCT f.id) > 1
  ORDER BY a.label, f.properties->>'key'
`;

/**
 * Realign label to properties.key and clear the stale embedding. Clearing both
 * embedding and embedding_model satisfies kg_nodes_embedding_model_stamped.
 * Does not touch last_confirmed_at (recency tiebreak for duplicate keys).
 */
export const APPLY_BY_IDS_SQL = `
  UPDATE kg_nodes
  SET label = properties->>'key',
      embedding = NULL,
      embedding_model = NULL
  WHERE id = ANY($1::uuid[])
`;

function requireString(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (typeof v !== 'string') {
    throw new Error(`repair-config-store-labels: expected string column "${field}", got ${typeof v}`);
  }
  return v;
}

function requireStringArray(row: Record<string, unknown>, field: string): string[] {
  const v = row[field];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`repair-config-store-labels: expected string[] column "${field}"`);
  }
  return v as string[];
}

export function parseMismatchRows(rows: unknown[]): MismatchedConfigFact[] {
  return rows.map((raw) => {
    if (raw === null || typeof raw !== 'object') {
      throw new Error('repair-config-store-labels: row is not an object');
    }
    const row = raw as Record<string, unknown>;
    return {
      id: requireString(row, 'id'),
      anchorLabels: requireStringArray(row, 'anchor_labels'),
      label: requireString(row, 'label'),
      key: requireString(row, 'key'),
      valuePreview: requireString(row, 'value_preview'),
    };
  });
}

export function parseDuplicateRows(rows: unknown[]): DuplicateKeyGroup[] {
  return rows.map((raw) => {
    if (raw === null || typeof raw !== 'object') {
      throw new Error('repair-config-store-labels: duplicate row is not an object');
    }
    const row = raw as Record<string, unknown>;
    return {
      anchorLabel: requireString(row, 'anchor_label'),
      key: requireString(row, 'key'),
      factIds: requireStringArray(row, 'fact_ids'),
      labels: requireStringArray(row, 'labels'),
    };
  });
}

export async function runRepair(
  pool: PoolLike,
  options: { apply: boolean },
): Promise<RepairResult> {
  const listed = await pool.query(LIST_MISMATCHED_SQL);
  const mismatched = parseMismatchRows(listed.rows);

  const dupListed = await pool.query(LIST_DUPLICATE_KEYS_SQL);
  const duplicates = parseDuplicateRows(dupListed.rows);

  if (!options.apply || mismatched.length === 0) {
    return { dryRun: !options.apply, mismatched, duplicates, updatedCount: 0 };
  }

  const ids = mismatched.map((m) => m.id);
  const updated = await pool.query(APPLY_BY_IDS_SQL, [ids]);
  return {
    dryRun: false,
    mismatched,
    duplicates,
    updatedCount: updated.rowCount ?? 0,
  };
}

export function formatRepairReport(result: RepairResult): string {
  const mode = result.dryRun ? 'DRY-RUN' : 'APPLY';
  const lines = [
    `config-store label repair (#2252) — ${mode}`,
    '',
    `  mismatched facts: ${result.mismatched.length}`,
    `  duplicate (anchor, key) groups: ${result.duplicates.length}`,
    ...(result.dryRun ? [] : [`  rows updated:     ${result.updatedCount}`]),
    '',
  ];

  if (result.mismatched.length === 0) {
    lines.push('  (no label≠key mismatches)');
  } else {
    lines.push('  id                                   | anchors                   | label → key');
    lines.push('  -------------------------------------+---------------------------+---------------------------');
    for (const m of result.mismatched) {
      const id = m.id.padEnd(36);
      const anchors = m.anchorLabels.join(',').slice(0, 25).padEnd(25);
      lines.push(`  ${id} | ${anchors} | ${m.label} → ${m.key}`);
      if (m.valuePreview.length > 0) {
        lines.push(`      value: ${m.valuePreview}`);
      }
    }
  }

  if (result.duplicates.length > 0) {
    lines.push('');
    lines.push('  Duplicate keys (manual review — values may disagree):');
    for (const d of result.duplicates) {
      lines.push(`    ${d.anchorLabel} / ${d.key}: ${d.factIds.length} facts (labels: ${d.labels.join(', ')})`);
    }
  }

  lines.push('');
  lines.push(
    '  Note: values overwritten by the original merge cannot be recovered from the graph.',
  );
  if (result.dryRun) {
    lines.push('  Re-run with --apply to set each label to properties.key and clear stale embeddings.');
  } else if (result.updatedCount > 0) {
    lines.push(
      '  Embeddings for repaired rows were cleared (exactKey writes do not need them).',
    );
  }
  return lines.join('\n');
}

// CLI entry — pathToFileURL handles '#', '?', '%' in the checkout path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const main = async (): Promise<void> => {
    const apply = process.argv.includes('--apply');
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      logger.error('repair-config-store-labels: DATABASE_URL is not set');
      process.exitCode = 1;
      return;
    }
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const result = await runRepair(pool, { apply });
      process.stdout.write(`${formatRepairReport(result)}\n`);
      logger.info(
        {
          dryRun: result.dryRun,
          mismatchedCount: result.mismatched.length,
          duplicateGroups: result.duplicates.length,
          updatedCount: result.updatedCount,
        },
        'repair-config-store-labels: done',
      );
    } catch (err) {
      logger.error({ err }, 'repair-config-store-labels: fatal error');
      process.exitCode = 1;
    } finally {
      try {
        await pool.end();
      } catch (endErr) {
        logger.error({ err: endErr }, 'repair-config-store-labels: failed to close the pool');
        process.exitCode = 1;
      }
    }
  };
  await main();
}
