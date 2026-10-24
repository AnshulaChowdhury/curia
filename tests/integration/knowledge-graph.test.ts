import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL } from '../../src/memory/embedding-profiles.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createLogger, createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;

// Skip if DATABASE_URL is not set (CI may not have pgvector)
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('Knowledge Graph Integration', () => {
  let pool: pg.Pool;
  let store: KnowledgeGraphStore;
  let entityMemory: EntityMemory;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = createLogger('error');
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    // Verify pgvector extension and tables exist
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  // Integration files share one database and run in parallel, so teardown deletes only
  // the nodes this file created (#2183). Edges cascade from their nodes, but are deleted
  // explicitly to keep the FK order visible. This file creates no contacts.
  const createdKgNodeIds: string[] = [];

  afterAll(async () => {
    try {
      if (createdKgNodeIds.length > 0) {
        await pool.query(
          'DELETE FROM kg_edges WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)',
          [createdKgNodeIds],
        );
        await pool.query('DELETE FROM kg_nodes WHERE id = ANY($1)', [createdKgNodeIds]);
      }
    } finally {
      await pool.end();
    }
  });

  it('creates and retrieves a node from Postgres', async () => {
    const node = await store.createNode({
      type: 'person',
      label: 'Integration Test Person',
      properties: { test: true },
      source: 'integration-test',
    });
    createdKgNodeIds.push(node.id);

    const retrieved = await store.getNode(node.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.label).toBe('Integration Test Person');
    expect(retrieved!.embedding).toBeDefined();
    expect(retrieved!.embedding).toHaveLength(OPENAI_TEXT_EMBEDDING_3_SMALL.dimensions);
  });

  it('stamps each stored vector with the profile model', async () => {
    const node = await store.createNode({
      type: 'person',
      label: 'Stamped Integration Person',
      properties: {},
      source: 'integration-test',
    });
    createdKgNodeIds.push(node.id);

    const { rows } = await pool.query<{ embedding_model: string | null }>(
      'SELECT embedding_model FROM kg_nodes WHERE id = $1',
      [node.id],
    );
    expect(rows[0]!.embedding_model).toBe(OPENAI_TEXT_EMBEDDING_3_SMALL.model);
    expect((await store.getNode(node.id))!.embeddingModel).toBe(OPENAI_TEXT_EMBEDDING_3_SMALL.model);
  });

  it('leaves a vector from another model out of semantic search', async () => {
    const label = 'model filter integration probe';
    const node = await store.createNode({ type: 'concept', label, properties: {}, source: 'integration-test' });
    createdKgNodeIds.push(node.id);
    // The fake backend embeds the same text to the same vector, so the probe ranks first.
    expect((await store.semanticSearch(label, { limit: 1 }))[0]!.node.id).toBe(node.id);

    await pool.query("UPDATE kg_nodes SET embedding_model = 'another-model' WHERE id = $1", [node.id]);

    const ids = (await store.semanticSearch(label, { limit: 50 })).map(r => r.node.id);
    expect(ids).not.toContain(node.id);
  });

  it('restamps a node from another model when its label changes', async () => {
    const node = await store.createNode({ type: 'person', label: 'Restamp probe', properties: {}, source: 'integration-test' });
    createdKgNodeIds.push(node.id);
    await pool.query("UPDATE kg_nodes SET embedding_model = 'another-model' WHERE id = $1", [node.id]);

    await store.updateNode(node.id, { label: 'Restamp probe renamed' });

    expect((await store.getNode(node.id))!.embeddingModel).toBe(OPENAI_TEXT_EMBEDDING_3_SMALL.model);
  });

  it('does not merge a fact into one embedded by another model', async () => {
    const validator = new MemoryValidator(store, EmbeddingService.createForTesting());
    const entity = await store.createNode({ type: 'person', label: 'Dedup probe person', properties: {}, source: 'integration-test' });
    const fact = await store.createNode({ type: 'fact', label: 'Dedup probe lives in Kitchener', properties: {}, source: 'integration-test' });
    createdKgNodeIds.push(entity.id, fact.id);
    await store.createEdge({ sourceNodeId: entity.id, targetNodeId: fact.id, type: 'relates_to', properties: {}, source: 'integration-test' });
    const write = { entityNodeId: entity.id, label: 'Dedup probe lives in Kitchener', source: 'integration-test' };
    expect((await validator.validate(write)).action).toBe('update');

    await pool.query("UPDATE kg_nodes SET embedding_model = 'another-model' WHERE id = $1", [fact.id]);

    expect((await validator.validate(write)).action).toBe('create');
  });

  it('performs semantic search via pgvector', async () => {
    const node = await store.createNode({
      type: 'concept',
      label: 'quarterly revenue targets',
      properties: {},
      source: 'integration-test',
    });
    createdKgNodeIds.push(node.id);

    const results = await store.semanticSearch('financial goals');
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0]!.score).toBe('number');
  });

  it('traverses graph relationships in Postgres', async () => {
    const a = await store.createNode({ type: 'person', label: 'Traverse-A', properties: {}, source: 'test' });
    const b = await store.createNode({ type: 'project', label: 'Traverse-B', properties: {}, source: 'test' });
    createdKgNodeIds.push(a.id, b.id);
    await store.createEdge({ sourceNodeId: a.id, targetNodeId: b.id, type: 'works_on', properties: {}, source: 'test' });

    const result = await store.traverse(a.id, { maxDepth: 1 });
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });

  it('stores and retrieves entity facts via EntityMemory', async () => {
    const { entity, created } = await entityMemory.createEntity({
      type: 'person',
      label: 'Integration Person',
      properties: {},
      source: 'test',
    });
    // createEntity upserts by label: only delete the node if this call minted it.
    if (created) createdKgNodeIds.push(entity.id);

    const fact = await entityMemory.storeFact({
      entityNodeId: entity.id,
      label: 'Integration Person is a test entity',
      source: 'test',
    });
    // 'updated' returns an existing fact node, which is not ours to delete.
    if (fact.action === 'created' && fact.nodeId) createdKgNodeIds.push(fact.nodeId);

    const facts = await entityMemory.getFacts(entity.id);
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  it('getConnectedFacts returns each fact once across edge directions and types', async () => {
    // Covers the Postgres SQL that backs EntityMemory.getFacts + both dedup paths
    // (#2252 re-review): both directions, archived edge/fact, non-fact neighbour,
    // and a doubly-linked fact (two edge types) must not duplicate.
    const entity = await store.createNode({
      type: 'concept',
      label: `getConnectedFacts entity ${Date.now()}`,
      properties: {},
      source: 'integration-test',
    });
    const forward = await store.createNode({
      type: 'fact',
      label: 'forward fact',
      properties: { key: 'fwd' },
      source: 'integration-test',
    });
    const reverse = await store.createNode({
      type: 'fact',
      label: 'reverse fact',
      properties: { key: 'rev' },
      source: 'integration-test',
    });
    const doubled = await store.createNode({
      type: 'fact',
      label: 'doubled fact',
      properties: { key: 'dbl' },
      source: 'integration-test',
    });
    const archivedFact = await store.createNode({
      type: 'fact',
      label: 'archived fact',
      properties: { key: 'arch' },
      source: 'integration-test',
    });
    const viaArchivedEdge = await store.createNode({
      type: 'fact',
      label: 'via archived edge',
      properties: { key: 'arch-edge' },
      source: 'integration-test',
    });
    const nonFact = await store.createNode({
      type: 'person',
      label: `non-fact neighbour ${Date.now()}`,
      properties: {},
      source: 'integration-test',
    });
    createdKgNodeIds.push(
      entity.id, forward.id, reverse.id, doubled.id,
      archivedFact.id, viaArchivedEdge.id, nonFact.id,
    );

    await store.createEdge({
      sourceNodeId: entity.id,
      targetNodeId: forward.id,
      type: 'relates_to',
      properties: {},
      source: 'integration-test',
    });
    await store.createEdge({
      sourceNodeId: reverse.id,
      targetNodeId: entity.id,
      type: 'relates_to',
      properties: {},
      source: 'integration-test',
    });
    await store.createEdge({
      sourceNodeId: entity.id,
      targetNodeId: doubled.id,
      type: 'relates_to',
      properties: {},
      source: 'integration-test',
    });
    await store.createEdge({
      sourceNodeId: entity.id,
      targetNodeId: doubled.id,
      type: 'mentioned_in',
      properties: {},
      source: 'integration-test',
    });
    await store.createEdge({
      sourceNodeId: entity.id,
      targetNodeId: archivedFact.id,
      type: 'relates_to',
      properties: {},
      source: 'integration-test',
    });
    const archivedEdge = await store.createEdge({
      sourceNodeId: entity.id,
      targetNodeId: viaArchivedEdge.id,
      type: 'relates_to',
      properties: {},
      source: 'integration-test',
    });
    await store.createEdge({
      sourceNodeId: entity.id,
      targetNodeId: nonFact.id,
      type: 'relates_to',
      properties: {},
      source: 'integration-test',
    });

    await store.archiveNode(archivedFact.id);
    await store.archiveEdge(archivedEdge.id);

    const facts = await store.getConnectedFacts(entity.id);
    const ids = facts.map((f) => f.id).sort();
    expect(ids).toEqual([forward.id, reverse.id, doubled.id].sort());
    expect(facts.filter((f) => f.id === doubled.id)).toHaveLength(1);
  });
});
