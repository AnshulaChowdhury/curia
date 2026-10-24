// scripts/repair-config-store-labels.ts
//
// One-off repair for config-store facts whose label diverged from properties.key
// after semantic dedup merged similar keys (#2252).
//
// What it fixes:
//   UPDATE kg_nodes SET label = properties->>'key'
//   for fact nodes hanging off a config:<namespace> anchor where
//   label IS DISTINCT FROM properties->>'key'.
//
// What it cannot fix:
//   Values overwritten by the merge are gone from the graph. The script lists
//   each mismatched row (anchor, old label, key, value preview) so an operator
//   can see which keys were lost; recovering those values is out of scope.
//
// Dry-run (default): report only. Pass --apply to write.
//
// Run:  pnpm run repair:config-store-labels
//       pnpm run repair:config-store-labels -- --apply
//
// On prod (container already has DATABASE_URL):
//   docker exec curia-curia-1 ./node_modules/.bin/tsx \
//     scripts/repair-config-store-labels.ts
//   docker exec curia-curia-1 ./node_modules/.bin/tsx \
//     scripts/repair-config-store-labels.ts --apply

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
  anchorLabel: string;
  label: string;
  key: string;
  /** Truncated value for operator review — overwritten siblings are not recoverable. */
  valuePreview: string;
}

export interface RepairResult {
  dryRun: boolean;
  mismatched: MismatchedConfigFact[];
  /** Rows updated when dryRun is false; always 0 in dry-run. */
  updatedCount: number;
}

/**
 * Config-anchor facts where the node label no longer matches properties.key.
 * Joins through relates_to in either direction. Only non-archived concept
 * anchors whose label starts with `config:` — the meta-index
 * (`config-store-index`) is excluded because its facts use label=namespace
 * without a parallel key property.
 */
export const LIST_MISMATCHED_SQL = `
  SELECT DISTINCT
    f.id,
    a.label AS anchor_label,
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
  ORDER BY a.label, f.properties->>'key', f.id
`;

export const APPLY_BY_IDS_SQL = `
  UPDATE kg_nodes
  SET label = properties->>'key',
      last_confirmed_at = now()
  WHERE id = ANY($1::uuid[])
`;

function requireString(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (typeof v !== 'string') {
    throw new Error(`repair-config-store-labels: expected string column "${field}", got ${typeof v}`);
  }
  return v;
}

export function parseMismatchRows(rows: unknown[]): MismatchedConfigFact[] {
  return rows.map((raw) => {
    if (raw === null || typeof raw !== 'object') {
      throw new Error('repair-config-store-labels: row is not an object');
    }
    const row = raw as Record<string, unknown>;
    return {
      id: requireString(row, 'id'),
      anchorLabel: requireString(row, 'anchor_label'),
      label: requireString(row, 'label'),
      key: requireString(row, 'key'),
      valuePreview: requireString(row, 'value_preview'),
    };
  });
}

export async function runRepair(
  pool: PoolLike,
  options: { apply: boolean },
): Promise<RepairResult> {
  const listed = await pool.query(LIST_MISMATCHED_SQL);
  const mismatched = parseMismatchRows(listed.rows);

  if (!options.apply || mismatched.length === 0) {
    return { dryRun: !options.apply, mismatched, updatedCount: 0 };
  }

  const ids = mismatched.map((m) => m.id);
  const updated = await pool.query(APPLY_BY_IDS_SQL, [ids]);
  return {
    dryRun: false,
    mismatched,
    updatedCount: updated.rowCount ?? 0,
  };
}

export function formatRepairReport(result: RepairResult): string {
  const mode = result.dryRun ? 'DRY-RUN' : 'APPLY';
  const lines = [
    `config-store label repair (#2252) — ${mode}`,
    '',
    `  mismatched facts: ${result.mismatched.length}`,
    ...(result.dryRun ? [] : [`  rows updated:     ${result.updatedCount}`]),
    '',
  ];

  if (result.mismatched.length === 0) {
    lines.push('  (none — label and properties.key already agree on every config fact)');
    return lines.join('\n');
  }

  lines.push('  id                                   | anchor                    | label → key');
  lines.push('  -------------------------------------+---------------------------+---------------------------');
  for (const m of result.mismatched) {
    const id = m.id.padEnd(36);
    const anchor = m.anchorLabel.slice(0, 25).padEnd(25);
    lines.push(`  ${id} | ${anchor} | ${m.label} → ${m.key}`);
    if (m.valuePreview.length > 0) {
      lines.push(`      value: ${m.valuePreview}`);
    }
  }
  lines.push('');
  lines.push(
    '  Note: values overwritten by the original merge cannot be recovered from the graph.',
  );
  if (result.dryRun) {
    lines.push('  Re-run with --apply to set each label to properties.key.');
    lines.push('  After apply, embeddings still reflect the old label until `pnpm reembed:kg`.');
  }
  return lines.join('\n');
}

// CLI entry point — only runs when executed directly (not when imported by tests)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
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
