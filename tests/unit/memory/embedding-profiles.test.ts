import { describe, it, expect } from 'vitest';
import {
  lookupEmbeddingProfile,
  parseEmbeddingProfiles,
  OPENAI_TEXT_EMBEDDING_3_SMALL,
} from '../../../src/memory/embedding-profiles.js';

const SOURCE = 'test';

const fullEntry = {
  dimensions: 1024,
  prefixes: { query: 'Q: ' },
  thresholds: { fact_dedup: 0.8, fuzzy_resolve: 0.7, fuzzy_ambiguity_floor: 0.5 },
};

describe('lookupEmbeddingProfile', () => {
  it('finds a built-in profile by exact model name', () => {
    expect(lookupEmbeddingProfile('text-embedding-3-small', undefined)).toBe(OPENAI_TEXT_EMBEDDING_3_SMALL);
  });

  it('returns undefined for an unprofiled model', () => {
    expect(lookupEmbeddingProfile('Text-Embedding-3-Small', undefined)).toBeUndefined();
  });

  it('prefers an operator override over the built-in profile', () => {
    const override = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, dimensions: 512 };
    expect(lookupEmbeddingProfile('text-embedding-3-small', { 'text-embedding-3-small': override })).toBe(override);
  });
});

describe('parseEmbeddingProfiles', () => {
  it('reads a complete entry, defaulting missing prefixes to empty', () => {
    expect(parseEmbeddingProfiles({ custom: fullEntry }, SOURCE)).toEqual({
      custom: {
        model: 'custom',
        dimensions: 1024,
        prefixes: { query: 'Q: ', document: '', similarity: '' },
        thresholds: { factDedup: 0.8, fuzzyResolve: 0.7, fuzzyAmbiguityFloor: 0.5 },
      },
    });
  });

  it('copies a built-in base under another model id and applies overrides', () => {
    const profiles = parseEmbeddingProfiles(
      { 'openai-proxy-id': { base: 'text-embedding-3-small', thresholds: { fact_dedup: 0.95 } } },
      SOURCE,
    );
    expect(profiles['openai-proxy-id']).toEqual({
      ...OPENAI_TEXT_EMBEDDING_3_SMALL,
      model: 'openai-proxy-id',
      thresholds: { ...OPENAI_TEXT_EMBEDDING_3_SMALL.thresholds, factDedup: 0.95 },
    });
  });

  it('rejects an entry without a base that leaves out a threshold', () => {
    expect(() => parseEmbeddingProfiles(
      { custom: { dimensions: 1024, thresholds: { fact_dedup: 0.8, fuzzy_resolve: 0.7 } } },
      SOURCE,
    )).toThrow(/fuzzy_ambiguity_floor must be a number/);
  });

  it('rejects a base that is not a built-in profile', () => {
    expect(() => parseEmbeddingProfiles({ custom: { base: 'nope' } }, SOURCE)).toThrow(/base must name a built-in profile/);
  });

  it('rejects a width above the HNSW limit', () => {
    expect(() => parseEmbeddingProfiles({ custom: { ...fullEntry, dimensions: 2560 } }, SOURCE)).toThrow(/from 1 to 2000/);
  });

  it('rejects an ambiguity floor at or above the resolve threshold', () => {
    expect(() => parseEmbeddingProfiles(
      { custom: { ...fullEntry, thresholds: { fact_dedup: 0.9, fuzzy_resolve: 0.7, fuzzy_ambiguity_floor: 0.7 } } },
      SOURCE,
    )).toThrow(/must be below fuzzy_resolve/);
  });

  it('rejects a misspelt key instead of falling back to the base value', () => {
    expect(() => parseEmbeddingProfiles(
      { custom: { base: 'text-embedding-3-small', thresholds: { fuzzy_resolv: 0.8 } } },
      SOURCE,
    )).toThrow(/unknown key\(s\) fuzzy_resolv/);
  });

  it('rejects a section that is not a mapping', () => {
    expect(() => parseEmbeddingProfiles(['custom'], SOURCE)).toThrow(/must be a mapping/);
  });
});
