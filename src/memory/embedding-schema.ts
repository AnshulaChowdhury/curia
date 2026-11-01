// Whether kg_nodes is ready for the configured embedding profile (ADR-051).
//
// Boot runs this before building entity memory. A changed model or width never rewrites
// stored vectors on its own: the knowledge graph stays off and the log names the command
// that re-embeds. The one exception is a table holding no vectors, where a resize at boot
// loses nothing.
import type { DbPool, DbPoolClient } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { HNSW_MAX_DIMENSIONS, embeddingStamp, type EmbeddingProfile } from './embedding-profiles.js';
import { describeEmbeddingUnavailable, resolveEmbedding, type EmbeddingEndpoint } from './embedding.js';
import { REEMBED_APPLICATION_NAME, describeInstanceLockHolder, findInstanceLockHolder } from '../db/instance-lock.js';

export const REEMBED_COMMAND = 'pnpm reembed:kg';
const REEMBED_DOCS_URL = 'https://docs.meetcuria.com/integrations/embeddings-endpoint';

/** How to run the re-embed command, for a log line an operator acts on. */
export const REEMBED_INSTRUCTIONS =
  `Stop Curia, run ${REEMBED_COMMAND}, then start Curia`;

/** Where a Docker install finds how to run the command, which depends on its compose file. */
export const REEMBED_DOCKER_NOTE = `For a Docker install, see ${REEMBED_DOCS_URL}.`;

export interface ReembedRun {
  id: number;
  startedAt: Date;
  targetModel: string;
  targetDimensions: number;
  rowsTotal: number;
  rowsDone: number;
}

export interface EmbeddingSchemaSnapshot {
  /** The declared width of kg_nodes.embedding; null when the column has no width. */
  columnDimensions: number | null;
  /** Rows holding a vector, by their stamp (`embeddingStamp()` of the profile that made it). */
  vectorsByModel: Record<string, number>;
  /** The unfinished re-embed, if one is recorded. */
  openRun: ReembedRun | undefined;
}

export type EmbeddingSchemaState =
  | { status: 'ok' }
  | { status: 'resized'; fromDimensions: number | null; toDimensions: number }
  | { status: 'off'; reason: 'open_run'; run: ReembedRun }
  | { status: 'off'; reason: 'width_mismatch'; columnDimensions: number | null; profileDimensions: number; vectorCount: number }
  | { status: 'off'; reason: 'model_mismatch'; stamp: string; otherModelVectors: number; vectorsByModel: Record<string, number> };

type Queryable = DbPool | DbPoolClient;

export async function readEmbeddingSchema(db: Queryable): Promise<EmbeddingSchemaSnapshot> {
  // For pgvector's vector(n), atttypmod is n itself; -1 means no declared width.
  const column = await db.query<{ atttypmod: number }>(
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'kg_nodes'::regclass AND attname = 'embedding' AND NOT attisdropped`,
  );
  const typmod = column.rows[0]?.atttypmod;
  const columnDimensions = typmod !== undefined && typmod > 0 ? typmod : null;

  const models = await db.query<{ embedding_model: string; count: number }>(
    `SELECT embedding_model, count(*)::int AS count FROM kg_nodes
      WHERE embedding IS NOT NULL GROUP BY embedding_model`,
  );
  const vectorsByModel: Record<string, number> = {};
  for (const row of models.rows) vectorsByModel[row.embedding_model] = row.count;

  const runs = await db.query<{
    id: string;
    started_at: Date;
    target_model: string;
    target_dimensions: number;
    rows_total: number;
    rows_done: number;
  }>(
    `SELECT id, started_at, target_model, target_dimensions, rows_total, rows_done
       FROM kg_reembed_runs WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1`,
  );
  const run = runs.rows[0];
  return {
    columnDimensions,
    vectorsByModel,
    openRun: run && {
      id: Number(run.id),
      startedAt: run.started_at,
      targetModel: run.target_model,
      targetDimensions: run.target_dimensions,
      rowsTotal: run.rows_total,
      rowsDone: run.rows_done,
    },
  };
}

function totalVectors(snapshot: EmbeddingSchemaSnapshot): number {
  return Object.values(snapshot.vectorsByModel).reduce((sum, n) => sum + n, 0);
}

/** The state a snapshot puts the knowledge graph in, before any resize. */
function classify(snapshot: EmbeddingSchemaSnapshot, profile: EmbeddingProfile): EmbeddingSchemaState | 'needs_resize' {
  // An open run comes first: its rows may all look complete while some still wait for a vector.
  if (snapshot.openRun) return { status: 'off', reason: 'open_run', run: snapshot.openRun };

  const vectorCount = totalVectors(snapshot);
  if (snapshot.columnDimensions !== profile.dimensions) {
    if (vectorCount === 0) return 'needs_resize';
    return {
      status: 'off',
      reason: 'width_mismatch',
      columnDimensions: snapshot.columnDimensions,
      profileDimensions: profile.dimensions,
      vectorCount,
    };
  }

  const stamp = embeddingStamp(profile);
  const otherModelVectors = vectorCount - (snapshot.vectorsByModel[stamp] ?? 0);
  if (otherModelVectors > 0) {
    return {
      status: 'off',
      reason: 'model_mismatch',
      stamp,
      otherModelVectors,
      vectorsByModel: snapshot.vectorsByModel,
    };
  }
  return { status: 'ok' };
}

/**
 * Drops the HNSW index, sets the column's width, and recreates the index with migration
 * 004's definition. Every vector must already be null: pgvector refuses to cast a stored
 * vector to another width. Runs on the caller's client, inside the caller's transaction.
 */
export async function resizeEmbeddingColumn(client: DbPoolClient, dimensions: number): Promise<void> {
  // A type modifier cannot be a bind parameter, so the width is interpolated. It is
  // checked to be an integer in range first, which leaves nothing else to inject.
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > HNSW_MAX_DIMENSIONS) {
    throw new Error(`resizeEmbeddingColumn: width must be an integer from 1 to ${HNSW_MAX_DIMENSIONS}, got ${dimensions}`);
  }
  await client.query('DROP INDEX IF EXISTS idx_kg_nodes_embedding');
  await client.query(`ALTER TABLE kg_nodes ALTER COLUMN embedding TYPE vector(${dimensions})`);
  await client.query('CREATE INDEX idx_kg_nodes_embedding ON kg_nodes USING hnsw (embedding vector_cosine_ops)');
}

/**
 * Decides whether boot may build entity memory for `profile`. Resizes the column itself
 * only when no row holds a vector and no re-embed is open, re-checking both under a table
 * lock so a concurrent writer cannot slip a vector in between.
 */
export async function checkEmbeddingSchema(
  pool: DbPool,
  profile: EmbeddingProfile,
  logger: Logger,
): Promise<EmbeddingSchemaState> {
  const first = classify(await readEmbeddingSchema(pool), profile);
  if (first !== 'needs_resize') return first;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE kg_nodes IN ACCESS EXCLUSIVE MODE');
    const snapshot = await readEmbeddingSchema(client);
    const state = classify(snapshot, profile);
    if (state !== 'needs_resize') {
      await client.query('ROLLBACK');
      return state;
    }
    await resizeEmbeddingColumn(client, profile.dimensions);
    await client.query('COMMIT');
    logger.info(
      { fromDimensions: snapshot.columnDimensions, toDimensions: profile.dimensions, embeddingModel: embeddingStamp(profile) },
      'kg_nodes.embedding resized for the embedding profile (the table held no vectors)',
    );
    return { status: 'resized', fromDimensions: snapshot.columnDimensions, toDimensions: profile.dimensions };
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      logger.error({ err: rollbackErr }, 'checkEmbeddingSchema: rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
}

/** The warn line for a knowledge graph the schema check turned off. */
export function describeEmbeddingSchemaOff(state: Extract<EmbeddingSchemaState, { status: 'off' }>): string {
  switch (state.reason) {
    case 'open_run':
      return `A knowledge-graph re-embed started ${state.run.startedAt.toISOString()} did not finish ` +
        `(${state.run.rowsDone} of ${state.run.rowsTotal} rows embedded with ${state.run.targetModel}). ` +
        `To finish it: ${REEMBED_INSTRUCTIONS}. ${REEMBED_DOCKER_NOTE}`;
    case 'width_mismatch':
      return `kg_nodes.embedding holds ${state.vectorCount} vectors of width ${state.columnDimensions ?? 'unset'}, ` +
        `but the embedding profile needs ${state.profileDimensions}. ${REEMBED_INSTRUCTIONS}. ${REEMBED_DOCKER_NOTE}`;
    case 'model_mismatch':
      return `${state.otherModelVectors} knowledge-graph vectors were made by another model or document prefix than ${state.stamp} ` +
        `(${JSON.stringify(state.vectorsByModel)}). ${REEMBED_INSTRUCTIONS}. ${REEMBED_DOCKER_NOTE}`;
  }
}

export type KnowledgeGraphEmbedding =
  | { ok: true; endpoint: EmbeddingEndpoint; profile: EmbeddingProfile }
  | { ok: false; gate: 'config'; message: string }
  | { ok: false; gate: 'schema'; message: string; state?: Extract<EmbeddingSchemaState, { status: 'off' }>; err?: unknown };

/**
 * Whether entity memory may run: resolves the endpoint and profile, then runs the schema
 * check. A running `pnpm reembed:kg` turns it off even when the table looks ready, because
 * the command takes the instance lock before it clears vectors.
 */
export async function resolveKnowledgeGraphEmbedding(
  pool: DbPool,
  config: Parameters<typeof resolveEmbedding>[0],
  profileOverrides: Parameters<typeof resolveEmbedding>[1],
  logger: Logger,
): Promise<KnowledgeGraphEmbedding> {
  const embedding = resolveEmbedding(config, profileOverrides);
  if (!embedding.ok) return { ok: false, gate: 'config', message: `${describeEmbeddingUnavailable(embedding)}.` };
  let state: EmbeddingSchemaState;
  try {
    const holder = await findInstanceLockHolder(pool);
    if (holder?.applicationName === REEMBED_APPLICATION_NAME) {
      return {
        ok: false,
        gate: 'schema',
        message: `${REEMBED_COMMAND} is running against this database (it holds the instance lock: ` +
          `${describeInstanceLockHolder(holder)}). Restart Curia when it finishes.`,
      };
    }
    state = await checkEmbeddingSchema(pool, embedding.profile, logger);
  } catch (err) {
    return { ok: false, gate: 'schema', message: 'The embedding schema check failed.', err };
  }
  if (state.status === 'off') return { ok: false, gate: 'schema', message: describeEmbeddingSchemaOff(state), state };
  return { ok: true, endpoint: embedding.endpoint, profile: embedding.profile };
}
