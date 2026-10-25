// Filtered semantic search must not let nodes that fail the filter crowd out the ones
// that pass it (#2248). Facts outnumber entities and often name their entity, so they
// can sit closer to a query than the entity itself. Two ways that hid the entity:
//   - the fuzzy phase of resolveOrCreate took the 5 nearest nodes of any type and only
//     then dropped facts, so 5 closer facts left no candidate and a duplicate was created;
//   - a type / sensitivity filter ran after an HNSW scan, which returns only its
//     hnsw.ef_search (40) nearest before the WHERE clause sees them.
// InMemoryBackend filters before ranking, so only Postgres can catch either.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { embeddingStamp } from '../../src/memory/embedding-profiles.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import type { NodeType, Sensitivity } from '../../src/memory/types.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('KG semantic search with filters (#2248)', () => {
  const embedder = EmbeddingService.createForTesting();
  const stamp = embeddingStamp(embedder.profile);
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool;
  // A pool whose planner reaches for the HNSW index whenever a query allows it, as it does
  // on a production-sized table. On a test-sized table it would scan and sort instead.
  let indexPool: pg.Pool;
  const created: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    indexPool = new Pool({ connectionString: DATABASE_URL, options: '-c enable_seqscan=off -c enable_sort=off' });
  });

  // Integration files share one database and run in parallel, so teardown deletes only
  // the nodes this file created (#2183).
  afterAll(async () => {
    try {
      if (created.length > 0) {
        await pool.query('DELETE FROM kg_edges WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)', [created]);
        await pool.query('DELETE FROM kg_nodes WHERE id = ANY($1)', [created]);
      }
    } finally {
      await indexPool.end();
      await pool.end();
    }
  });

  // Seeded so a failure reproduces.
  let seed = 2248;
  const rand = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
  const unit = (v: number[]): number[] => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / norm);
  };

  /** A vector whose cosine to `query` is exactly `cosine`: the query plus a random orthogonal part. */
  const at = (query: number[], cosine: number): string => {
    const u = unit(query);
    const r = u.map(() => rand());
    const dot = r.reduce((s, x, i) => s + x * u[i]!, 0);
    const w = unit(r.map((x, i) => x - dot * u[i]!));
    const sin = Math.sqrt(1 - cosine * cosine);
    return `[${u.map((x, i) => cosine * x + sin * w[i]!).join(',')}]`;
  };

  /** Insert a node and pin its vector, bypassing the fake embedder. */
  const node = async (
    type: NodeType,
    label: string,
    vector: string,
    sensitivity: Sensitivity = 'internal',
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, embedding, embedding_model, sensitivity, source, identity_source)
       VALUES ($1, $2, '{}', $3::vector, $4, $5, 'integration-test', 'label') RETURNING id`,
      [type, label, vector, stamp, sensitivity],
    );
    created.push(rows[0]!.id);
    return rows[0]!.id;
  };

  const storeOn = (p: pg.Pool) => KnowledgeGraphStore.createWithPostgres(p, embedder, createSilentLogger());

  it('fuzzy resolution finds the entity when more than 5 facts about it sit closer', async () => {
    const existing = `Crowded Acme ${runId}`;
    const incoming = `Crowded ACME Corporation ${runId}`;
    const query = await embedder.embed(incoming, 'similarity');

    const org = await node('organization', existing, at(query, 0.95)); // above fuzzyResolve (0.90)
    // 60 facts closer than the entity: past both the old LIMIT 5 and HNSW's ef_search of 40.
    for (let i = 0; i < 60; i++) {
      await node('fact', `${existing} fact ${i}`, at(query, 0.98));
    }

    for (const p of [pool, indexPool]) {
      const store = storeOn(p);
      const memory = new EntityMemory(store, new MemoryValidator(store, embedder), embedder, createSilentLogger());
      const result = await memory.resolveOrCreate({ type: 'organization', label: incoming, source: 'integration-test' });
      if (result.kind === 'created') created.push(result.node.id);
      expect(result).toMatchObject({ kind: 'found', node: { id: org } });
    }
  });

  it('a type filter returns matching nodes nearest-first past ef_search closer non-matches', async () => {
    const query = await embedder.embed(`type filter probe ${runId}`, 'query');
    const near = await node('organization', `Type probe near ${runId}`, at(query, 0.9));
    const far = await node('organization', `Type probe far ${runId}`, at(query, 0.8));
    for (let i = 0; i < 60; i++) {
      await node('fact', `Type probe fact ${i} ${runId}`, at(query, 0.97));
    }

    const results = await storeOn(indexPool).semanticSearch(`type filter probe ${runId}`, { type: 'organization', limit: 5 });
    const ids = results.map(r => r.node.id);
    expect(ids).toContain(near);
    expect(ids).toContain(far);
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(far));
    expect(results.every(r => r.node.type === 'organization')).toBe(true);
    expect(results[ids.indexOf(near)]!.score).toBeCloseTo(0.9, 3);
  });

  it('a sensitivity ceiling returns allowed nodes past ef_search closer restricted ones', async () => {
    const query = await embedder.embed(`sensitivity probe ${runId}`, 'query');
    const allowed = await node('concept', `Sensitivity probe allowed ${runId}`, at(query, 0.85), 'internal');
    for (let i = 0; i < 60; i++) {
      await node('concept', `Sensitivity probe restricted ${i} ${runId}`, at(query, 0.97), 'restricted');
    }

    const results = await storeOn(indexPool).semanticSearch(`sensitivity probe ${runId}`, { maxSensitivity: 'internal', limit: 5 });
    expect(results.map(r => r.node.id)).toContain(allowed);
    expect(results.every(r => r.node.sensitivity === 'internal' || r.node.sensitivity === 'public')).toBe(true);
  });
});
