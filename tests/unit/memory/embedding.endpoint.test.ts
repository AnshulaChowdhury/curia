// embedding.endpoint.test.ts — unit tests for OpenAI-compatible embedding endpoints:
// endpoint and profile resolution from config, the request the backend sends, and how it
// fits a wider vector to the profile's width.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EmbeddingService,
  resolveEmbeddingEndpoint,
  resolveEmbedding,
  describeEmbeddingUnavailable,
  redactUrlUserinfo,
} from '../../../src/memory/embedding.js';
import { createSilentLogger } from '../../../src/logger.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL, type EmbeddingProfile } from '../../../src/memory/embedding-profiles.js';

const logger = createSilentLogger();
const EMBEDDING_DIMENSIONS = OPENAI_TEXT_EMBEDDING_3_SMALL.dimensions;
const profile: EmbeddingProfile = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, model: 'm' };

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

  it('returns undefined for a custom base URL with no model, rather than assuming OpenAI\'s', () => {
    expect(resolveEmbeddingEndpoint({ ...noEmbeddingConfig, embeddingBaseUrl: 'http://embed.local/v1' })).toBeUndefined();
  });
});

describe('resolveEmbedding', () => {
  it('reports no endpoint when nothing is configured', () => {
    expect(resolveEmbedding(noEmbeddingConfig, undefined)).toEqual({ ok: false, reason: 'no_endpoint' });
  });

  it('pairs the OpenAI default with its built-in profile', () => {
    const resolution = resolveEmbedding({ ...noEmbeddingConfig, openaiApiKey: 'sk-test' }, undefined);
    expect(resolution.ok && resolution.profile).toBe(OPENAI_TEXT_EMBEDDING_3_SMALL);
  });

  it('turns the knowledge graph off for a custom base URL with no model, naming EMBEDDING_MODEL', () => {
    const resolution = resolveEmbedding(
      { ...noEmbeddingConfig, embeddingBaseUrl: 'http://embed.local/v1', openaiApiKey: 'sk-test' },
      undefined,
    );
    expect(resolution).toEqual({ ok: false, reason: 'no_model' });
    if (resolution.ok) throw new Error('expected the knowledge graph off');
    expect(describeEmbeddingUnavailable(resolution)).toContain('EMBEDDING_MODEL');
  });

  it('turns the knowledge graph off for a model with no profile, naming the model', () => {
    expect(resolveEmbedding(
      { ...noEmbeddingConfig, embeddingBaseUrl: 'http://embed.local/v1', embeddingModel: 'unprofiled' },
      undefined,
    )).toEqual({ ok: false, reason: 'no_profile', model: 'unprofiled' });
  });

  it('uses an operator profile for a model the built-in table lacks', () => {
    const custom: EmbeddingProfile = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, model: 'custom', dimensions: 1024 };
    const resolution = resolveEmbedding(
      { ...noEmbeddingConfig, embeddingBaseUrl: 'http://embed.local/v1', embeddingModel: 'custom' },
      { custom },
    );
    expect(resolution.ok && resolution.profile).toBe(custom);
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
      profile,
      logger,
    );

    await service.embed('hello', 'document');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://embed.local/v1/embeddings');
    expect(init.headers['Authorization']).toBe('Bearer local-key');
    expect(JSON.parse(init.body).model).toBe('qwen3-embedding-4b');
  });

  it('sends no Authorization header when the endpoint has no key', async () => {
    const fetchMock = stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      logger,
    );

    await service.embed('hello', 'document');

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
      profile,
      logger,
    );

    const embedding = await service.embed('hello', 'document');

    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedding[0]).toBeCloseTo(1 / Math.sqrt(EMBEDDING_DIMENSIONS));
    expect(Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0))).toBeCloseTo(1);
  });

  it('warns once per backend the first time it truncates, naming the model and both widths', async () => {
    stubFetch(Array.from({ length: 2560 }, () => 1));
    const testLogger = createSilentLogger();
    const warnSpy = vi.spyOn(testLogger, 'warn');
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'wide-model', apiKey: undefined },
      profile,
      testLogger,
    );

    await service.embed('first', 'document');
    await service.embed('second', 'document');

    expect(warnSpy).toHaveBeenCalledOnce();
    const [fields, message] = warnSpy.mock.calls[0]! as unknown as [Record<string, unknown>, string];
    expect(fields).toEqual({ model: 'wide-model', returnedDimensions: 2560, profileDimensions: EMBEDDING_DIMENSIONS });
    expect(message).toContain('only valid for Matryoshka-trained models');
  });

  it('does not warn when the vector already has the profile width', async () => {
    stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const testLogger = createSilentLogger();
    const warnSpy = vi.spyOn(testLogger, 'warn');
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      testLogger,
    );

    await service.embed('hello', 'document');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still rejects a vector narrower than the profile width', async () => {
    stubFetch(Array.from({ length: 1024 }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      logger,
    );

    await expect(service.embed('hello', 'document')).rejects.toThrow('Unexpected embedding dimensions: 1024');
  });

  it('asks the server for the profile width and cuts to it', async () => {
    const fetchMock = stubFetch(Array.from({ length: 2560 }, () => 1));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      { ...profile, dimensions: 2000 },
      logger,
    );

    const embedding = await service.embed('hello', 'document');

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).dimensions).toBe(2000);
    expect(embedding).toHaveLength(2000);
  });

  it('sends the purpose prefix as part of the input', async () => {
    const fetchMock = stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      { ...profile, prefixes: { query: 'Instruct: find\nQuery: ', document: '', similarity: '' } },
      logger,
    );

    await service.embed('who is Ada', 'query');
    await service.embed('Ada Lovelace', 'document');

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).input).toBe('Instruct: find\nQuery: who is Ada');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).input).toBe('Ada Lovelace');
  });
});

describe('redactUrlUserinfo', () => {
  it('drops a user and password from the URL', () => {
    expect(redactUrlUserinfo('https://user:s3cr%40t@embed.example:8443/v1')).toBe('https://embed.example:8443/v1');
  });

  it('drops a user with no password', () => {
    expect(redactUrlUserinfo('http://token@embed.example/v1')).toBe('http://embed.example/v1');
  });

  it('leaves a URL without userinfo unchanged, including an @ in its path', () => {
    expect(redactUrlUserinfo('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
    expect(redactUrlUserinfo('http://embed.example/v1/@team')).toBe('http://embed.example/v1/@team');
  });
});
