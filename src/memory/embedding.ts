import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import { createEmbeddingCall, createEmbeddingError } from '../bus/events.js';
import {
  lookupEmbeddingProfile,
  OPENAI_TEXT_EMBEDDING_3_SMALL,
  type EmbeddingProfile,
  type EmbeddingPurpose,
} from './embedding-profiles.js';

export const DEFAULT_EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_EMBEDDING_MODEL = OPENAI_TEXT_EMBEDDING_3_SMALL.model;

/**
 * Where embeddings come from. OpenAI by default; any server that speaks OpenAI's
 * /embeddings API (llama.cpp, Ollama, vLLM, text-embeddings-inference) otherwise.
 */
export interface EmbeddingEndpoint {
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token. Undefined for a local server that takes no key. */
  apiKey: string | undefined;
}

/**
 * Picks the embedding endpoint from config, or returns undefined when none is configured
 * and entity memory should stay off. A custom base URL uses `embedding_api_key`, which may
 * be absent, and needs `EMBEDDING_MODEL`; the default OpenAI URL needs `openai_api_key`.
 */
export function resolveEmbeddingEndpoint(config: {
  embeddingBaseUrl: string | undefined;
  embeddingModel: string | undefined;
  embeddingApiKey: string | undefined;
  openaiApiKey: string | undefined;
}): EmbeddingEndpoint | undefined {
  if (config.embeddingBaseUrl) {
    // No default model here: a server that ignores the model field (llama.cpp does) would
    // answer under OpenAI's name, and its vectors would pass as OpenAI's.
    if (!config.embeddingModel) return undefined;
    return {
      baseUrl: config.embeddingBaseUrl.replace(/\/+$/, ''),
      model: config.embeddingModel,
      apiKey: config.embeddingApiKey,
    };
  }
  if (!config.openaiApiKey) return undefined;
  return {
    baseUrl: DEFAULT_EMBEDDING_BASE_URL,
    model: config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    apiKey: config.openaiApiKey,
  };
}

/** `url` without any `user:password@` part, for a log line. */
export function redactUrlUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
}

export type EmbeddingResolution =
  | { ok: true; endpoint: EmbeddingEndpoint; profile: EmbeddingProfile }
  | { ok: false; reason: 'no_endpoint' }
  | { ok: false; reason: 'no_model' }
  | { ok: false; reason: 'no_profile'; model: string };

/**
 * The one place that decides whether entity memory has an embedding source: the endpoint
 * and the profile for its model, or the reason the knowledge graph stays off. Every
 * construction site uses it, so a custom endpoint reaches all of them.
 */
export function resolveEmbedding(
  config: Parameters<typeof resolveEmbeddingEndpoint>[0],
  profileOverrides: Readonly<Record<string, EmbeddingProfile>> | undefined,
): EmbeddingResolution {
  if (config.embeddingBaseUrl && !config.embeddingModel) return { ok: false, reason: 'no_model' };
  const endpoint = resolveEmbeddingEndpoint(config);
  if (!endpoint) return { ok: false, reason: 'no_endpoint' };
  const profile = lookupEmbeddingProfile(endpoint.model, profileOverrides);
  if (!profile) return { ok: false, reason: 'no_profile', model: endpoint.model };
  return { ok: true, endpoint, profile };
}

/** One log line explaining why the knowledge graph is off, for a failed resolution. */
export function describeEmbeddingUnavailable(resolution: Exclude<EmbeddingResolution, { ok: true }>): string {
  if (resolution.reason === 'no_endpoint') {
    return 'No embedding endpoint: set EMBEDDING_BASE_URL and EMBEDDING_MODEL, or seed openai_api_key in the vault';
  }
  if (resolution.reason === 'no_model') {
    return 'EMBEDDING_BASE_URL is set but EMBEDDING_MODEL is not. Set EMBEDDING_MODEL to the model the server runs, which must have an embedding profile';
  }
  return `No embedding profile for model "${resolution.model}". Add one under embedding.profiles in config/local.yaml (dimensions, prefixes, thresholds) to enable it`;
}

// Internal interface separating the transport/mock concern from the service API.
// Lets us swap OpenAI for a deterministic fake in tests without touching callers.
interface EmbeddingBackend {
  embed(text: string): Promise<number[]>;
}

export class EmbeddingService {
  private constructor(
    private backend: EmbeddingBackend,
    readonly profile: EmbeddingProfile,
  ) {}

  // Production factory for any OpenAI-compatible /embeddings endpoint.
  // Pass bus and modelRegistry to enable embedding.call telemetry.
  // Both are optional so the service still works without them, but in production
  // both should always be provided so costs appear in the audit log.
  static createWithEndpoint(
    endpoint: EmbeddingEndpoint,
    profile: EmbeddingProfile,
    logger: Logger,
    bus?: EventBus,
    modelRegistry?: ModelRegistry,
  ): EmbeddingService {
    return new EmbeddingService(new OpenAIBackend(endpoint, profile.dimensions, logger, bus, modelRegistry), profile);
  }

  // Test factory — produces deterministic vectors without any network calls.
  static createForTesting(profile: EmbeddingProfile = OPENAI_TEXT_EMBEDDING_3_SMALL): EmbeddingService {
    return new EmbeddingService(new FakeEmbeddingBackend(profile.dimensions), profile);
  }

  async embed(text: string, purpose: EmbeddingPurpose): Promise<number[]> {
    return this.backend.embed(this.profile.prefixes[purpose] + text);
  }

  /**
   * Computes cosine similarity between two vectors.
   * Returns a value in [-1, 1]; 1.0 = identical direction, 0 = orthogonal.
   * Returns 0 if either vector is the zero vector (safe default).
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    // Callers should never pass mismatched vectors — surface misuse immediately
    // rather than silently computing a nonsensical similarity score.
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      // Arrays are guaranteed same length by the check above; ! asserts index is in-bounds
      const ai = a[i]!;
      const bi = b[i]!;
      dotProduct += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    // Guard against division by zero when a vector is all zeros.
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }
}

// -- Production backend: calls an OpenAI-compatible /embeddings endpoint --

class OpenAIBackend implements EmbeddingBackend {
  constructor(
    private endpoint: EmbeddingEndpoint,
    private dimensions: number,
    private logger: Logger,
    private bus?: EventBus,
    private modelRegistry?: ModelRegistry,
  ) {}

  async embed(text: string): Promise<number[]> {
    const start = Date.now();
    // Wrap the fetch so network errors surface with context (text length helps
    // diagnose truncation or oversized input issues).
    let response: Response;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.endpoint.apiKey) headers['Authorization'] = `Bearer ${this.endpoint.apiKey}`;
      response = await fetch(`${this.endpoint.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.endpoint.model,
          input: text,
          // Honoured by OpenAI; servers that ignore it return the full width, cut below.
          dimensions: this.dimensions,
        }),
      });
    } catch (err) {
      // Publish embedding.error so HealthService can track embedding health.
      // Guard: bus is optional (may be null/undefined when used without bus wiring).
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'FETCH_FAILED',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      this.logger.error({ err, textLength: text.length }, 'OpenAI embedding fetch failed');
      throw new Error(`OpenAI embedding fetch error: ${(err as Error).message}`);
    }

    if (!response.ok) {
      // Use .catch() so a body-read failure doesn't swallow the HTTP error
      const body = await response.text().catch(() => '<body unreadable>');
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'API_ERROR',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      this.logger.error({ status: response.status, body }, 'OpenAI embedding request failed');
      throw new Error(`OpenAI embedding API error: ${response.status}`);
    }

    // Wrap JSON parse so a malformed response surfaces as a distinct error
    // rather than an unhandled rejection with no context.
    // usage is marked optional: OpenAI always includes it on success, but
    // malformed HTTP-200 error bodies may omit it; guard with ?? 0 below.
    let json: { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number } };
    try {
      json = await response.json() as { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number } };
    } catch (err) {
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'PARSE_ERROR',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      this.logger.error({ err }, 'OpenAI embedding response JSON parse failed');
      throw new Error(`OpenAI embedding response parse error: ${(err as Error).message}`);
    }

    let embedding = json.data[0]?.embedding;
    // Servers that ignore `dimensions` (llama.cpp, Ollama) return the model's full width.
    // For a Matryoshka-trained model such as Qwen3-Embedding, the leading dimensions are a
    // valid smaller embedding once rescaled to unit length.
    if (embedding && embedding.length > this.dimensions) {
      embedding = truncateAndNormalize(embedding, this.dimensions);
    }
    if (!embedding || embedding.length !== this.dimensions) {
      this.logger.error(
        { expected: this.dimensions, actual: embedding?.length },
        'OpenAI embedding dimension mismatch',
      );
      // Publish embedding.error so HealthService counts malformed responses as failures.
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'PARSE_ERROR',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      throw new Error(`Unexpected embedding dimensions: ${embedding?.length}`);
    }
    // Telemetry — fire-and-forget; must not block or break the caller.
    // void: don't await so embed() latency isn't coupled to bus/audit throughput.
    // ?? 0: usage is optional in the type — a missing field means 0 tokens recorded
    // (cost tracking gap), which is safer than throwing a TypeError.
    const latencyMs = Date.now() - start;
    void this.publishTelemetry(json.usage?.prompt_tokens ?? 0, latencyMs, text);
    return embedding;
  }

  // Publishes an embedding.call telemetry event. Non-fatal — any failure is
  // logged and swallowed so it never breaks the embed() call chain.
  // Only runs when both bus and modelRegistry are wired (production path).
  private async publishTelemetry(
    inputTokens: number,
    latencyMs: number,
    inputText: string,
  ): Promise<void> {
    if (!this.bus || !this.modelRegistry) return;
    try {
      const pricing = this.modelRegistry.getPricing(this.endpoint.model);
      // pricing will always be defined after Task 1 adds the registry entry,
      // but guard defensively so a misconfigured registry doesn't break embed().
      const estimatedCostUsd = pricing
        ? (inputTokens * pricing.inputPerMToken) / 1_000_000
        : 0;

      const event = createEmbeddingCall({
        model: this.endpoint.model,
        inputTokens,
        estimatedCostUsd,
        latencyMs,
        inputTextLength: inputText.length,
      });
      await this.bus.publish('system', event);
    } catch (err) {
      // Telemetry failures must never propagate — log at warn so they're visible
      // in dashboards without impacting the caller.
      this.logger.warn({ err }, 'OpenAIBackend: failed to publish embedding.call telemetry event — cost tracking gap');
    }
  }
}

export function truncateAndNormalize(vector: number[], dimensions: number): number[] {
  const head = vector.slice(0, dimensions);
  const norm = Math.sqrt(head.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? head : head.map(x => x / norm);
}

// -- Test backend: deterministic fake using a simple LCG seeded by string hash --
// This produces stable, repeatable vectors that differ per input — no network needed.

class FakeEmbeddingBackend implements EmbeddingBackend {
  constructor(private dimensions: number) {}

  async embed(text: string): Promise<number[]> {
    // djb2-style hash: cheap, non-crypto, good enough to differentiate strings
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Force 32-bit integer truncation
    }

    // LCG (linear congruential generator) seeded by the hash to fill the profile's width.
    // Constants from glibc — well-known period, adequate for test use.
    const embedding: number[] = [];
    let seed = Math.abs(hash);
    for (let i = 0; i < this.dimensions; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // Map [0, 0x7fffffff] → [-1, 1] to satisfy the cosine similarity contract
      embedding.push((seed / 0x7fffffff) * 2 - 1);
    }
    return embedding;
  }
}
