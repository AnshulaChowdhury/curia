// tests/integration/config-store-exact-key.test.ts
//
// Cross-process safety of ConfigStore exact-key writes (#2252, PR #2284 review).
// Two independent stacks, each with its own pg.Pool, stand in for two Curia
// processes on one database: the in-process write queue cannot see the other
// stack, so only the Postgres advisory lock keeps a missing key to one fact.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { createLogger, createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

interface Stack {
  pool: pg.Pool;
  entityMemory: EntityMemory;
  configStore: ConfigStore;
}

function makeStack(): Stack {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, createLogger('error'));
  const validator = new MemoryValidator(store, embeddingService);
  const entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());
  return { pool, entityMemory, configStore: new ConfigStore(entityMemory, createSilentLogger()) };
}

describeIf('ConfigStore exact-key writes across processes', () => {
  let a: Stack;
  let b: Stack;
  // Unique per run: integration files share one database (#2183).
  const namespace = `it_exact_key_${Date.now()}`;
  // Teardown deletes rows only once the database check has passed.
  let onTestDatabase = false;

  beforeAll(async () => {
    a = makeStack();
    b = makeStack();
    // Refuse anything but the isolated test database before writing a single row.
    // Both pools use the same DATABASE_URL, so checking one covers the other.
    await requireCuriaTestDatabase(a.pool);
    onTestDatabase = true;
  });

  afterAll(async () => {
    try {
      if (!onTestDatabase) return;
      // The anchor and every fact on it; edges cascade from their nodes.
      await a.pool.query(
        `DELETE FROM kg_nodes WHERE id IN (
           SELECT f.id FROM kg_nodes f
             JOIN kg_edges e ON e.target_node_id = f.id
             JOIN kg_nodes anchor ON anchor.id = e.source_node_id
            WHERE anchor.label = $1
         ) OR label = $1`,
        [`config:${namespace}`],
      );
    } finally {
      await Promise.all([a.pool.end(), b.pool.end()]);
    }
  });

  it('creates one fact per key when two processes write the same missing keys at once', async () => {
    await a.configStore.set(namespace, 'other', 'x'); // anchor exists; the keys below do not
    // Open connections on both pools first: a cold pool delays its first query by a
    // connection handshake, which would let the other process finish and hide the race.
    await Promise.all([a, b].flatMap((s) => [0, 1, 2, 3].map(() => s.pool.query('SELECT 1'))));
    await b.configStore.get(namespace, 'other');

    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    for (const key of keys) {
      const results = await Promise.all([
        a.configStore.set(namespace, key, 'from-a'),
        b.configStore.set(namespace, key, 'from-b'),
      ]);
      expect(results.every((r) => r.stored)).toBe(true);
      expect(results.filter((r) => r.action === 'created')).toHaveLength(1);
    }

    const anchors = await a.entityMemory.findEntities(`config:${namespace}`);
    expect(anchors).toHaveLength(1);
    const facts = await a.entityMemory.getFacts(anchors[0]!.id);
    for (const key of keys) {
      expect(facts.filter((f) => f.properties.key === key)).toHaveLength(1);
    }
  });
});
