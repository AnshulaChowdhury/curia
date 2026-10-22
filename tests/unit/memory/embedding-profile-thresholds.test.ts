// Fact dedup and fuzzy resolution read their thresholds from the configured profile
// (ADR-051). Each case stores a vector at a known cosine similarity to the incoming one,
// below OpenAI's threshold and above the looser profile's, and checks that the outcome
// follows the profile.

import { describe, it, expect } from 'vitest';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { createSilentLogger } from '../../../src/logger.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL, type EmbeddingProfile } from '../../../src/memory/embedding-profiles.js';

const LOOSE: EmbeddingProfile = {
  ...OPENAI_TEXT_EMBEDDING_3_SMALL,
  model: 'test-loose',
  thresholds: { factDedup: 0.80, fuzzyResolve: 0.80, fuzzyAmbiguityFloor: 0.70 },
};

// A unit vector whose cosine similarity to `target` is exactly `similarity`.
async function vectorAt(service: EmbeddingService, target: number[], similarity: number): Promise<number[]> {
  const unit = (v: number[]) => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / norm);
  };
  const t = unit(target);
  const other = await service.embed('an unrelated direction', 'similarity');
  const dot = other.reduce((s, x, i) => s + x * t[i]!, 0);
  const perpendicular = unit(other.map((x, i) => x - dot * t[i]!));
  const rest = Math.sqrt(1 - similarity * similarity);
  return t.map((x, i) => similarity * x + rest * perpendicular[i]!);
}

function setUp(profile: EmbeddingProfile) {
  const service = EmbeddingService.createForTesting(profile);
  const store = KnowledgeGraphStore.createInMemory(service);
  const validator = new MemoryValidator(store, service);
  return { service, store, validator, memory: new EntityMemory(store, validator, service, createSilentLogger()) };
}

async function factDedupAction(profile: EmbeddingProfile) {
  const { service, store, validator } = setUp(profile);
  const label = 'Bob prefers green tea';
  const entity = await store.createNode({ type: 'person', label: 'Bob', properties: {}, source: 'test' });
  const fact = await store.createNode({
    type: 'fact', label: 'Bob likes green tea', properties: {}, source: 'test',
    embedding: await vectorAt(service, await service.embed(label, 'similarity'), 0.85),
  });
  await store.createEdge({ sourceNodeId: entity.id, targetNodeId: fact.id, type: 'relates_to', properties: {}, source: 'test' });
  return (await validator.validate({ entityNodeId: entity.id, label, source: 'test' })).action;
}

async function resolveKind(profile: EmbeddingProfile) {
  const { service, store, memory } = setUp(profile);
  const label = 'Darlise';
  await store.createNode({
    type: 'organization', label: 'Darlise Restaurant', properties: {}, source: 'test',
    embedding: await vectorAt(service, await service.embed(label, 'similarity'), 0.85),
  });
  return (await memory.resolveOrCreate({ label, type: 'organization', source: 'test' })).kind;
}

describe('thresholds come from the embedding profile', () => {
  it('merges a fact at 0.85 under a profile whose fact-dedup threshold is 0.80, and not under OpenAI\'s', async () => {
    expect(await factDedupAction(OPENAI_TEXT_EMBEDDING_3_SMALL)).toBe('create');
    expect(await factDedupAction(LOOSE)).toBe('update');
  });

  it('resolves a name at 0.85 under a profile whose fuzzy-resolve threshold is 0.80, and not under OpenAI\'s', async () => {
    expect(await resolveKind(OPENAI_TEXT_EMBEDDING_3_SMALL)).toBe('ambiguous');
    expect(await resolveKind(LOOSE)).toBe('found');
  });
});
