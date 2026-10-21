// Vectors carry the model that produced them (ADR-051). That nothing compares vectors
// across models is tested against Postgres in tests/integration/knowledge-graph.test.ts.

import { describe, it, expect } from 'vitest';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import {
  OPENAI_TEXT_EMBEDDING_3_SMALL,
  embeddingStamp,
  type EmbeddingProfile,
} from '../../../src/memory/embedding-profiles.js';

const PASSAGE: EmbeddingProfile = {
  ...OPENAI_TEXT_EMBEDDING_3_SMALL,
  prefixes: { ...OPENAI_TEXT_EMBEDDING_3_SMALL.prefixes, document: 'passage: ' },
};

function makeStore(profile: EmbeddingProfile = OPENAI_TEXT_EMBEDDING_3_SMALL) {
  return KnowledgeGraphStore.createInMemory(EmbeddingService.createForTesting(profile));
}

describe('embeddingStamp', () => {
  // Migration 102 backfills existing vectors with this literal.
  it('is the bare model name for OpenAI\'s profile', () => {
    expect(embeddingStamp(OPENAI_TEXT_EMBEDDING_3_SMALL)).toBe('text-embedding-3-small');
  });

  it('adds a hash of a non-empty document prefix, so a changed prefix changes the stamp', () => {
    const changed = { ...PASSAGE, prefixes: { ...PASSAGE.prefixes, document: 'search_document: ' } };
    expect(embeddingStamp(PASSAGE)).toMatch(/^text-embedding-3-small#document:[0-9a-f]{12}$/);
    expect(embeddingStamp(changed)).not.toBe(embeddingStamp(PASSAGE));
  });

  it('ignores the query and similarity prefixes, which are not stored in vectors', () => {
    const queryOnly = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, prefixes: { query: 'Q: ', document: '', similarity: 'S: ' } };
    expect(embeddingStamp(queryOnly)).toBe(OPENAI_TEXT_EMBEDDING_3_SMALL.model);
  });
});

describe('embedding model stamp', () => {
  it('stamps a new node with the profile model', async () => {
    const store = makeStore();
    const node = await store.createNode({ type: 'person', label: 'Ada', properties: {}, source: 'test' });
    expect(node.embeddingModel).toBe(OPENAI_TEXT_EMBEDDING_3_SMALL.model);
  });

  it('stamps a node made under a document prefix with that prefix\'s stamp', async () => {
    const store = makeStore(PASSAGE);
    const node = await store.createNode({ type: 'person', label: 'Ada', properties: {}, source: 'test' });
    expect(node.embeddingModel).toBe(embeddingStamp(PASSAGE));
    expect(await store.semanticSearch('Ada')).toHaveLength(1);
  });
});
