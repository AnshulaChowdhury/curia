// tests/unit/memory/config-store.test.ts
//
// System ConfigStore (src/memory/config-store.ts) exact-key semantics (#2252).
// Uses a real in-memory EntityMemory so storeFact runs through MemoryValidator.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigStore, matchConfigFact, listConfigEntries } from '../../../src/memory/config-store.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { KgNode } from '../../../src/memory/types.js';

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
    expect(facts.every((f) => f.properties.exact_key === true)).toBe(true);
  });

  it('updates the same key in place', async () => {
    await configStore.set('email', 'watermark', 't1');
    const second = await configStore.set('email', 'watermark', 't2');
    expect(second.stored).toBe(true);
    expect(second.action).toBe('updated');
    expect(await configStore.get('email', 'watermark')).toBe('t2');

    const anchors = await entityMemory.findEntities('config:email');
    const facts = await entityMemory.getFacts(anchors[0]!.id);
    expect(facts.filter((f) => f.properties.key === 'watermark')).toHaveLength(1);
  });

  it('get ignores a fact whose label matches but properties.key does not', async () => {
    const { entity } = await entityMemory.createEntity({
      type: 'concept',
      label: 'config:debrief',
      properties: { category: 'config', namespace: 'debrief' },
      source: 'test',
    });
    const planted = await entityMemory.storeFact({
      entityNodeId: entity.id,
      label: 'seen:old',
      properties: { key: 'seen:new', value: '1', namespace: 'debrief', exact_key: true },
      confidence: 0.9,
      decayClass: 'permanent',
      source: 'test',
      exactKey: true,
    });
    expect(planted.stored).toBe(true);
    await kgStore.updateNode(planted.nodeId!, { label: 'seen:old' });

    expect(await configStore.get('debrief', 'seen:old')).toBeNull();
    expect(await configStore.get('debrief', 'seen:new')).toBe('1');
  });

  it('falls back to label when properties.key is absent', async () => {
    const { entity } = await entityMemory.createEntity({
      type: 'concept',
      label: 'config:legacy',
      properties: { category: 'config', namespace: 'legacy' },
      source: 'test',
    });
    // Hand-crafted fact without properties.key
    await kgStore.createNode({
      type: 'fact',
      label: 'writing_guide_url',
      properties: { value: 'https://docs.example.com' },
      source: 'test',
    }).then(async (fact) => {
      await kgStore.createEdge({
        sourceNodeId: entity.id,
        targetNodeId: fact.id,
        type: 'relates_to',
        properties: {},
        source: 'test',
      });
    });

    expect(await configStore.get('legacy', 'writing_guide_url')).toBe('https://docs.example.com');
  });

  it('passes exactKey through storeFact', async () => {
    const spy = vi.spyOn(entityMemory, 'storeFact');
    await configStore.set('ns', 'k', 'v');
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![0].exactKey).toBe(true);
  });

  it('survives more than 50 system writes in one process (rate-limit exempt)', async () => {
    for (let i = 0; i < 55; i++) {
      const result = await configStore.set('email', 'watermark', `t${i}`);
      expect(result.stored).toBe(true);
    }
    expect(await configStore.get('email', 'watermark')).toBe('t54');
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

  it('creates one fact when overlapping writes target the same missing key', async () => {
    await configStore.set('ns', 'other', 'x'); // anchor exists; key 'k' does not
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => configStore.set('ns', 'k', `v${i}`)),
    );
    expect(results.every((r) => r.stored)).toBe(true);
    expect(results.filter((r) => r.action === 'created')).toHaveLength(1);

    const anchors = await entityMemory.findEntities('config:ns');
    const facts = await entityMemory.getFacts(anchors[0]!.id);
    expect(facts.filter((f) => f.properties.key === 'k')).toHaveLength(1);
    // Writes are applied in call order, so the last one wins.
    expect(await configStore.get('ns', 'k')).toBe('v4');
  });

  it('lets the next same-key write proceed after one fails', async () => {
    await configStore.set('ns', 'other', 'x');
    vi.spyOn(kgStore, 'createNode').mockRejectedValueOnce(new Error('db down'));
    const [first, second] = await Promise.allSettled([
      configStore.set('ns', 'k', 'v1'),
      configStore.set('ns', 'k', 'v2'),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    expect(await configStore.get('ns', 'k')).toBe('v2');
  });

  it('keeps concurrent writes to different keys as separate facts', async () => {
    await configStore.set('ns', 'other', 'x');
    const results = await Promise.all(['a', 'b', 'c'].map((k) => configStore.set('ns', k, k)));
    expect(results.map((r) => r.action)).toEqual(['created', 'created', 'created']);
    for (const k of ['a', 'b', 'c']) expect(await configStore.get('ns', k)).toBe(k);
  });

  describe('duplicate namespace anchors (anchor-create race)', () => {
    /** Two config:ns anchors; the second already holds key `k`. */
    async function twoAnchorsWithKeyOnSecond() {
      await configStore.set('ns', 'other', 'x'); // creates the first anchor
      const second = await kgStore.createNode({
        type: 'concept',
        label: 'config:ns',
        properties: { category: 'config', namespace: 'ns' },
        source: 'test',
      });
      const stored = await entityMemory.storeFact({
        entityNodeId: second.id,
        label: 'k',
        properties: { key: 'k', value: 'old', namespace: 'ns', exact_key: true },
        confidence: 0.9,
        decayClass: 'permanent',
        source: 'test',
        exactKey: true,
      });
      expect(stored.stored).toBe(true);
      const anchors = await entityMemory.findEntities('config:ns');
      // The routing below only matters if the key is NOT on the first anchor.
      expect(anchors).toHaveLength(2);
      expect(anchors[1]!.id).toBe(second.id);
      return { anchors, second };
    }

    it('updates the key on the anchor that holds it instead of creating a twin', async () => {
      const { anchors, second } = await twoAnchorsWithKeyOnSecond();

      const result = await configStore.set('ns', 'k', 'new');
      expect(result.action).toBe('updated');

      const allFacts = (await Promise.all(anchors.map((a) => entityMemory.getFacts(a.id)))).flat();
      expect(allFacts.filter((f) => f.properties.key === 'k')).toHaveLength(1);
      const onSecond = await entityMemory.getFacts(second.id);
      expect(onSecond.find((f) => f.properties.key === 'k')?.properties.value).toBe('new');
      expect(await configStore.get('ns', 'k')).toBe('new');
    });

    it('writes a new key to the first anchor', async () => {
      const { anchors } = await twoAnchorsWithKeyOnSecond();

      await configStore.set('ns', 'fresh', 'v');

      const onFirst = await entityMemory.getFacts(anchors[0]!.id);
      expect(onFirst.some((f) => f.properties.key === 'fresh')).toBe(true);
    });
  });
});

describe('listConfigEntries', () => {
  it('dedupes a legacy label-only twin against a keyed fact', () => {
    const facts = [
      {
        id: 'legacy',
        type: 'fact' as const,
        label: 'writing_guide_url',
        properties: { value: 'old' },
        temporal: {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          lastConfirmedAt: new Date('2026-01-01T00:00:00Z'),
          confidence: 1,
          decayClass: 'permanent' as const,
          source: 'test',
        },
        sensitivity: 'internal' as const,
        aliases: [],
        identitySource: 'label' as const,
      },
      {
        id: 'keyed',
        type: 'fact' as const,
        label: 'writing_guide_url',
        properties: { key: 'writing_guide_url', value: 'new' },
        temporal: {
          createdAt: new Date('2026-06-01T00:00:00Z'),
          lastConfirmedAt: new Date('2026-06-01T00:00:00Z'),
          confidence: 1,
          decayClass: 'permanent' as const,
          source: 'test',
        },
        sensitivity: 'internal' as const,
        aliases: [],
        identitySource: 'label' as const,
      },
    ];
    expect(listConfigEntries(facts)).toEqual([
      { key: 'writing_guide_url', value: 'new' },
    ]);
  });
});

describe('matchConfigFact', () => {
  function fact(partial: {
    id: string;
    label: string;
    key?: string;
    value: string;
    confirmedAt: string;
  }): KgNode {
    return {
      id: partial.id,
      type: 'fact',
      label: partial.label,
      properties: {
        ...(partial.key !== undefined ? { key: partial.key } : {}),
        value: partial.value,
      },
      temporal: {
        createdAt: new Date(partial.confirmedAt),
        lastConfirmedAt: new Date(partial.confirmedAt),
        confidence: 1,
        decayClass: 'permanent',
        source: 'test',
      },
      sensitivity: 'internal',
      aliases: [],
      identitySource: 'label',
    };
  }

  it('prefers the most recently confirmed properties.key match', () => {
    const facts = [
      fact({ id: 'a', label: 'k', key: 'k', value: 'old', confirmedAt: '2026-01-01T00:00:00Z' }),
      fact({ id: 'b', label: 'k', key: 'k', value: 'new', confirmedAt: '2026-06-01T00:00:00Z' }),
    ];
    expect(matchConfigFact(facts, 'k')?.properties.value).toBe('new');
  });

  it('does not match on label when properties.key differs', () => {
    const facts = [
      fact({
        id: 'a',
        label: 'processed_event_ids_1',
        key: 'processed_event_ids_3',
        value: 'wrong',
        confirmedAt: '2026-01-01T00:00:00Z',
      }),
    ];
    expect(matchConfigFact(facts, 'processed_event_ids_1')).toBeUndefined();
    expect(matchConfigFact(facts, 'processed_event_ids_3')?.properties.value).toBe('wrong');
  });
});
