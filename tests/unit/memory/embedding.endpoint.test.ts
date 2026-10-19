// embedding.endpoint.test.ts — unit tests for OpenAI-compatible embedding endpoints:
// endpoint resolution from config, the request the backend sends, and how it fits a
// wider vector to EMBEDDING_DIMENSIONS.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EmbeddingService,
  resolveEmbeddingEndpoint,
} from '../../../src/memory/embedding.js';
import { createSilentLogger } from '../../../src/logger.js';
import { EMBEDDING_DIMENSIONS } from '../../../src/memory/types.js';

const logger = createSilentLogger();

const noEmbeddingConfig = {
  embeddingBaseUrl: undefined,
  embeddingModel: undefined,
  embeddingApiKey: undefined,
  openaiApiKey: undefined,
};

function stubFetch(embedding: number[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [{ embedding }], usage: { prompt_tokens: 3 } }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveEmbeddingEndpoint', () => {
  it('returns undefined when neither a base URL nor an OpenAI key is set', () => {
    expect(resolveEmbeddingEndpoint(noEmbeddingConfig)).toBeUndefined();
  });

  it('defaults to OpenAI with the OpenAI key', () => {
    expect(resolveEmbeddingEndpoint({ ...noEmbeddingConfig, openaiApiKey: 'sk-test' })).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
    });
  });

  it('uses the custom base URL with the embedding key, never the OpenAI key', () => {
    expect(resolveEmbeddingEndpoint({
      embeddingBaseUrl: 'http://embed.local/v1/',
      embeddingModel: 'qwen3-embedding-4b',
      embeddingApiKey: undefined,
      openaiApiKey: 'sk-test',
    })).toEqual({
      baseUrl: 'http://embed.local/v1',
      model: 'qwen3-embedding-4b',
      apiKey: undefined,
    });
  });
});

describe('EmbeddingService — custom endpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the configured URL and model with the configured key', async () => {
    const fetchMock = stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'qwen3-embedding-4b', apiKey: 'local-key' },
      logger,
    );

    await service.embed('hello');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://embed.local/v1/embeddings');
    expect(init.headers['Authorization']).toBe('Bearer local-key');
    expect(JSON.parse(init.body).model).toBe('qwen3-embedding-4b');
  });

  it('sends no Authorization header when the endpoint has no key', async () => {
    const fetchMock = stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      logger,
    );

    await service.embed('hello');

    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty('Authorization');
  });

  it('keeps the leading dimensions of a wider vector and rescales them to unit length', async () => {
    // 2560 values; the first EMBEDDING_DIMENSIONS are all 2, the rest are noise that must be dropped.
    stubFetch([
      ...Array.from({ length: EMBEDDING_DIMENSIONS }, () => 2),
      ...Array.from({ length: 2560 - EMBEDDING_DIMENSIONS }, () => 99),
    ]);
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      logger,
    );

    const embedding = await service.embed('hello');

    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedding[0]).toBeCloseTo(1 / Math.sqrt(EMBEDDING_DIMENSIONS));
    expect(Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0))).toBeCloseTo(1);
  });

  it('still rejects a vector narrower than EMBEDDING_DIMENSIONS', async () => {
    stubFetch(Array.from({ length: 1024 }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      logger,
    );

    await expect(service.embed('hello')).rejects.toThrow('Unexpected embedding dimensions: 1024');
  });
});
