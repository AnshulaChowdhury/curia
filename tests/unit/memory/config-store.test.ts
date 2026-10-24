// tests/unit/memory/config-store.test.ts
//
// System ConfigStore (src/memory/config-store.ts) exact-key semantics (#2252).
// Uses a real in-memory EntityMemory so storeFact runs through MemoryValidator.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigStore } from '../../../src/memory/config-store.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('ConfigStore exact-key semantics', () => {
  let entityMemory: EntityMemory;
  let kgStore: KnowledgeGraphStore;
  let configStore: ConfigStore;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    kgStore = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, createSilentLogger());
    configStore = new ConfigStore(entityMemory, createSilentLogger());
  });

  it('keeps similar keys as separate facts and reads each by properties.key', async () => {
    await configStore.set('travel_detection', 'processed_event_ids_1', '["a"]');
    await configStore.set('travel_detection', 'processed_event_ids_2', '["b"]');
    await configStore.set('travel_detection', 'processed_event_ids_3', '["c"]');

    expect(await configStore.get('travel_detection', 'processed_event_ids_1')).toBe('["a"]');
    expect(await configStore.get('travel_detection', 'processed_event_ids_2')).toBe('["b"]');
    expect(await configStore.get('travel_detection', 'processed_event_ids_3')).toBe('["c"]');

    const anchors = await entityMemory.findEntities('config:travel_detection');
    const facts = await entityMemory.getFacts(anchors[0]!.id);
    expect(facts).toHaveLength(3);
  });

  it('updates the same key in place', async () => {
    await configStore.set('email', 'watermark', 't1');
    const second = await configStore.set('email', 'watermark', 't2');
    expect(second.stored).toBe(true);
    expect(await configStore.get('email', 'watermark')).toBe('t2');

    const anchors = await entityMemory.findEntities('config:email');
    const facts = await entityMemory.getFacts(anchors[0]!.id);
    expect(facts.filter((f) => f.properties.key === 'watermark')).toHaveLength(1);
  });

  it('get ignores a fact whose label matches but properties.key does not', async () => {
    // Simulate historical corruption: label still names the first key.
    const { entity } = await entityMemory.createEntity({
      type: 'concept',
      label: 'config:debrief',
      properties: { category: 'config', namespace: 'debrief' },
      source: 'test',
    });
    // Bypass ConfigStore — plant a mismatched fact the way the old merge left it.
    const planted = await entityMemory.storeFact({
      entityNodeId: entity.id,
      label: 'seen:old',
      properties: { key: 'seen:new', value: '1', namespace: 'debrief' },
      confidence: 0.9,
      decayClass: 'permanent',
      source: 'test',
      exactKey: true,
    });
    expect(planted.stored).toBe(true);
    // Force label divergence the way semantic merge did (exactKey keeps them aligned).
    await kgStore.updateNode(planted.nodeId!, { label: 'seen:old' });

    expect(await configStore.get('debrief', 'seen:old')).toBeNull();
    expect(await configStore.get('debrief', 'seen:new')).toBe('1');
  });

  it('passes exactKey through storeFact', async () => {
    const spy = vi.spyOn(entityMemory, 'storeFact');
    await configStore.set('ns', 'k', 'v');
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![0].exactKey).toBe(true);
  });

  it('realigns a diverged label when rewriting the same key', async () => {
    await configStore.set('ns', 'sheet_id.2026', 'id-v1');
    const anchors = await entityMemory.findEntities('config:ns');
    const before = await entityMemory.getFacts(anchors[0]!.id);
    const fact = before.find((f) => f.properties.key === 'sheet_id.2026');
    expect(fact).toBeDefined();
    await kgStore.updateNode(fact!.id, { label: 'sheet_id.2025' });

    await configStore.set('ns', 'sheet_id.2026', 'id-v2');

    const after = await entityMemory.getFacts(anchors[0]!.id);
    const fixed = after.find((f) => f.properties.key === 'sheet_id.2026');
    expect(fixed?.label).toBe('sheet_id.2026');
    expect(fixed?.properties.value).toBe('id-v2');
    expect(after).toHaveLength(1);
  });
});
