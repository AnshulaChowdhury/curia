import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL, type EmbeddingProfile } from '../../../src/memory/embedding-profiles.js';

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    service = EmbeddingService.createForTesting();
  });

  it('generates an embedding vector of correct dimensions', async () => {
    const embedding = await service.embed('Hello world', 'document');
    expect(embedding).toHaveLength(OPENAI_TEXT_EMBEDDING_3_SMALL.dimensions);
  });

  it('returns numbers between -1 and 1', async () => {
    const embedding = await service.embed('test input', 'document');
    for (const val of embedding) {
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('returns different embeddings for different inputs', async () => {
    const e1 = await service.embed('cats', 'document');
    const e2 = await service.embed('quantum physics', 'document');
    expect(e1).not.toEqual(e2);
  });

  it('returns identical embedding for identical input (deterministic in test mode)', async () => {
    const e1 = await service.embed('same input', 'document');
    const e2 = await service.embed('same input', 'document');
    expect(e1).toEqual(e2);
  });

  it('computes cosine similarity between two embeddings', () => {
    const v = [1, 0, 0];
    expect(EmbeddingService.cosineSimilarity(v, v)).toBeCloseTo(1.0);

    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('takes its width from the profile', async () => {
    const narrow: EmbeddingProfile = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, model: 'narrow', dimensions: 8 };
    const embedding = await EmbeddingService.createForTesting(narrow).embed('x', 'document');
    expect(embedding).toHaveLength(8);
  });

  it('puts the profile prefix for the purpose in front of the text', async () => {
    const prefixed: EmbeddingProfile = {
      ...OPENAI_TEXT_EMBEDDING_3_SMALL,
      model: 'prefixed',
      prefixes: { query: 'Q: ', document: '', similarity: '' },
    };
    const prefixedService = EmbeddingService.createForTesting(prefixed);
    // The fake backend is a pure function of its input, so equal vectors mean equal text.
    expect(await prefixedService.embed('cats', 'query')).toEqual(await prefixedService.embed('Q: cats', 'document'));
    expect(await prefixedService.embed('cats', 'similarity')).toEqual(await prefixedService.embed('cats', 'document'));
  });
});
