/**
 * Per-model embedding profiles (ADR-051). Similarity scores are not comparable across
 * models, so each model's prefixes and thresholds live together and a model without a
 * profile leaves the knowledge graph off.
 */
import { createHash } from 'node:crypto';

/** What an embedding is for. A model with task prompts formats each purpose differently. */
export type EmbeddingPurpose = 'query' | 'document' | 'similarity';

export interface EmbeddingProfile {
  /** The model name the endpoint is called with. Vectors carry `embeddingStamp()`, not this. */
  model: string;
  /** Vector width stored in kg_nodes.embedding. At most HNSW_MAX_DIMENSIONS. */
  dimensions: number;
  /** Text prepended to the input for each purpose. Empty for a model without task prompts. */
  prefixes: Record<EmbeddingPurpose, string>;
  thresholds: {
    /** Cosine score at or above which a new fact merges into an existing one. */
    factDedup: number;
    /** Cosine score at or above which fuzzy entity resolution auto-resolves. */
    fuzzyResolve: number;
    /** Cosine score below which a fuzzy candidate is not surfaced as ambiguous. */
    fuzzyAmbiguityFloor: number;
  };
}

/** pgvector's HNSW index refuses a `vector` column wider than this (pgvector 0.8.7, HNSW_MAX_DIM). */
export const HNSW_MAX_DIMENSIONS = 2000;

export const OPENAI_TEXT_EMBEDDING_3_SMALL: EmbeddingProfile = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
  prefixes: { query: '', document: '', similarity: '' },
  thresholds: { factDedup: 0.92, fuzzyResolve: 0.90, fuzzyAmbiguityFloor: 0.75 },
};

/**
 * A retrieval instruction on `similarity` was tried and stays out: it helps fact dedup but
 * hurts entity resolution, and one prefix serves both (ADR-051).
 */
export const QWEN3_EMBEDDING_4B: EmbeddingProfile = {
  model: 'Qwen3-Embedding-4B',
  dimensions: 1536,
  prefixes: {
    query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    document: '',
    similarity: '',
  },
  thresholds: { factDedup: 0.94, fuzzyResolve: 0.99, fuzzyAmbiguityFloor: 0.80 },
};

export const BUILTIN_EMBEDDING_PROFILES: Readonly<Record<string, EmbeddingProfile>> = {
  [OPENAI_TEXT_EMBEDDING_3_SMALL.model]: OPENAI_TEXT_EMBEDDING_3_SMALL,
  [QWEN3_EMBEDDING_4B.model]: QWEN3_EMBEDDING_4B,
};

/**
 * Returns the profile for a model: an operator override from `embedding.profiles` first,
 * then a built-in one. Undefined means nobody has profiled the model, and the knowledge
 * graph stays off rather than run on guessed thresholds.
 */
export function lookupEmbeddingProfile(
  model: string,
  overrides: Readonly<Record<string, EmbeddingProfile>> | undefined,
): EmbeddingProfile | undefined {
  return overrides?.[model] ?? BUILTIN_EMBEDDING_PROFILES[model];
}

/**
 * The value stored in kg_nodes.embedding_model beside each vector, and the only value
 * that stored stamps are compared with. Stored vectors keep the `document` prefix they
 * were made with, so a non-empty one is part of the stamp. A changed prefix under the
 * same model name then reads as a model mismatch to the boot gate and `pnpm reembed:kg`.
 * An empty prefix leaves the stamp as the model name, which migration 102's backfill wrote.
 */
export function embeddingStamp(profile: Pick<EmbeddingProfile, 'model' | 'prefixes'>): string {
  const prefix = profile.prefixes.document;
  if (prefix === '') return profile.model;
  return `${profile.model}#document:${createHash('sha256').update(prefix).digest('hex').slice(0, 12)}`;
}

const PURPOSES: readonly EmbeddingPurpose[] = ['query', 'document', 'similarity'];

const THRESHOLD_KEYS = {
  fact_dedup: 'factDedup',
  fuzzy_resolve: 'fuzzyResolve',
  fuzzy_ambiguity_floor: 'fuzzyAmbiguityFloor',
} as const;

/**
 * Validates `embedding.profiles` and returns profiles keyed by model name. An entry may
 * name a built-in as `base` and override fields; without a base it must give every field.
 * Throws on a malformed entry: a half-read profile would merge distinct people and facts.
 */
export function parseEmbeddingProfiles(raw: unknown, source: string): Record<string, EmbeddingProfile> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`embedding.profiles must be a mapping of model name to profile (in ${source})`);
  }

  const profiles: Record<string, EmbeddingProfile> = {};
  for (const [model, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    const at = `embedding.profiles["${model}"]`;
    if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) {
      throw new Error(`${at} must be a mapping (in ${source})`);
    }
    const entry = entryRaw as Record<string, unknown>;
    rejectUnknownKeys(entry, ['base', 'dimensions', 'prefixes', 'thresholds'], at, source);

    let base: EmbeddingProfile | undefined;
    if (entry['base'] !== undefined) {
      const baseName = entry['base'];
      if (typeof baseName !== 'string' || !BUILTIN_EMBEDDING_PROFILES[baseName]) {
        throw new Error(
          `${at}.base must name a built-in profile (${Object.keys(BUILTIN_EMBEDDING_PROFILES).join(', ')}), got: ${String(baseName)} (in ${source})`,
        );
      }
      base = BUILTIN_EMBEDDING_PROFILES[baseName];
    }

    const dimensions = entry['dimensions'] ?? base?.dimensions;
    if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > HNSW_MAX_DIMENSIONS) {
      throw new Error(`${at}.dimensions must be an integer from 1 to ${HNSW_MAX_DIMENSIONS}, got: ${String(dimensions)} (in ${source})`);
    }

    const prefixesRaw = entry['prefixes'];
    if (prefixesRaw !== undefined && (!prefixesRaw || typeof prefixesRaw !== 'object' || Array.isArray(prefixesRaw))) {
      throw new Error(`${at}.prefixes must be a mapping of query, document and similarity (in ${source})`);
    }
    const prefixesIn = (prefixesRaw ?? {}) as Record<string, unknown>;
    rejectUnknownKeys(prefixesIn, PURPOSES, `${at}.prefixes`, source);
    const prefixes = {} as Record<EmbeddingPurpose, string>;
    for (const purpose of PURPOSES) {
      // A profile with no base and no prefixes block is a model without task prompts.
      const value = prefixesIn[purpose] ?? base?.prefixes[purpose] ?? '';
      if (typeof value !== 'string') {
        throw new Error(`${at}.prefixes.${purpose} must be a string (in ${source})`);
      }
      prefixes[purpose] = value;
    }

    const thresholdsRaw = entry['thresholds'];
    if (thresholdsRaw !== undefined && (!thresholdsRaw || typeof thresholdsRaw !== 'object' || Array.isArray(thresholdsRaw))) {
      throw new Error(`${at}.thresholds must be a mapping (in ${source})`);
    }
    const thresholdsIn = (thresholdsRaw ?? {}) as Record<string, unknown>;
    rejectUnknownKeys(thresholdsIn, Object.keys(THRESHOLD_KEYS), `${at}.thresholds`, source);
    const thresholds = {} as EmbeddingProfile['thresholds'];
    for (const [yamlKey, key] of Object.entries(THRESHOLD_KEYS)) {
      const value = thresholdsIn[yamlKey] ?? base?.thresholds[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
        throw new Error(`${at}.thresholds.${yamlKey} must be a number in (0, 1], got: ${String(value)} (in ${source})`);
      }
      thresholds[key] = value;
    }
    if (thresholds.fuzzyAmbiguityFloor >= thresholds.fuzzyResolve) {
      throw new Error(`${at}.thresholds.fuzzy_ambiguity_floor must be below fuzzy_resolve (in ${source})`);
    }

    profiles[model] = { model, dimensions, prefixes, thresholds };
  }
  return profiles;
}

// A misspelt key would otherwise fall back to the base profile's value without a word.
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, source: string): void {
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${at} has unknown key(s) ${unknown.join(', ')}; allowed: ${allowed.join(', ')} (in ${source})`);
  }
}
