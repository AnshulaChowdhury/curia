// embedding-eval.ts — calibrates an embedding profile against a labelled fixture
// (ADR-051). It embeds the fixture through any OpenAI-compatible /embeddings
// endpoint, scores each requested width app-side, and prints the metrics and a suggested
// profile for `embedding.profiles`.
//
//   pnpm embedding-eval --base-url http://localhost:8080/v1 --model Qwen3-Embedding-4B \
//     --widths 1536,2000,2560 --key-env EMBED_KEY \
//     --query-prefix $'Instruct: <task>\nQuery:'
//
// --key-env names the environment variable that holds the endpoint's key, so the key is
// never on the command line. Omit it for a server that takes no key.
//
// The vectors are fetched once at the widest requested width, then truncated and
// renormalised per width exactly as the service does, so a width above the 2,000 the
// index allows can be measured without a schema change.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import pino from 'pino';
import { EmbeddingService, truncateAndNormalize } from '../src/memory/embedding.js';
import {
  OPENAI_TEXT_EMBEDDING_3_SMALL,
  type EmbeddingProfile,
  type EmbeddingPurpose,
} from '../src/memory/embedding-profiles.js';

export const DEFAULT_FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/embedding-eval/fixture.json');

/** Thresholds are picked on this grid, so a suggested value has two decimals like the shipped ones. */
const GRID_STEPS = 100;
/** The ambiguity floor keeps this share of true entity pairs above it. */
export const FLOOR_KEEP = 0.95;
const RECALL_AT = 5;
const CONCURRENCY = 4;

type Pair = [string, string];

export interface EvalFixture {
  entities: { match: Pair[]; distinct: Pair[] };
  facts: { merge: Pair[]; distinct: Pair[] };
  search: { corpus: string[]; queries: Array<{ query: string; relevant: string[] }> };
}

export function loadFixture(file: string): EvalFixture {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<EvalFixture>;
  const pairs = (v: unknown, at: string): Pair[] => {
    if (!Array.isArray(v) || v.some(p => !Array.isArray(p) || p.length !== 2 || p.some(s => typeof s !== 'string'))) {
      throw new Error(`${file}: ${at} must be a list of [string, string] pairs`);
    }
    return v as Pair[];
  };
  const corpus = raw.search?.corpus;
  const queries = raw.search?.queries;
  if (!Array.isArray(corpus) || !Array.isArray(queries)) {
    throw new Error(`${file}: search.corpus and search.queries must be lists`);
  }
  for (const q of queries) {
    const missing = q.relevant.filter(label => !corpus.includes(label));
    if (missing.length > 0) {
      throw new Error(`${file}: query "${q.query}" names labels missing from search.corpus: ${missing.join('; ')}`);
    }
  }
  return {
    entities: { match: pairs(raw.entities?.match, 'entities.match'), distinct: pairs(raw.entities?.distinct, 'entities.distinct') },
    facts: { merge: pairs(raw.facts?.merge, 'facts.merge'), distinct: pairs(raw.facts?.distinct, 'facts.distinct') },
    search: { corpus, queries },
  };
}

// -- Metrics over cosine scores. pos = pairs that should merge, neg = pairs that must not. --

/** Probability that a random true pair outscores a random false pair (ties count half). */
export function rocAuc(pos: readonly number[], neg: readonly number[]): number {
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

export interface ThresholdPoint {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  falseMerges: number;
}

/** Outcome of merging every pair whose score is at or above `threshold`, as the service does. */
export function scoreAt(pos: readonly number[], neg: readonly number[], threshold: number): ThresholdPoint {
  const tp = pos.filter(s => s >= threshold).length;
  const fp = neg.filter(s => s >= threshold).length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp / pos.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { threshold, precision, recall, f1, falseMerges: fp };
}

function grid(): number[] {
  return Array.from({ length: GRID_STEPS + 1 }, (_, i) => i / GRID_STEPS);
}

/** The grid threshold with the best F1; the highest one on a tie, since a false merge costs more. */
export function bestF1(pos: readonly number[], neg: readonly number[]): ThresholdPoint {
  let best = scoreAt(pos, neg, 0);
  for (const t of grid()) {
    const point = scoreAt(pos, neg, t);
    if (point.f1 >= best.f1) best = point;
  }
  return best;
}

/** The lowest grid threshold at which no false pair merges, or undefined if none on the grid does. */
export function noFalseMerge(pos: readonly number[], neg: readonly number[]): ThresholdPoint | undefined {
  for (const t of grid()) {
    const point = scoreAt(pos, neg, t);
    if (point.falseMerges === 0) return point;
  }
  return undefined;
}

/**
 * Picks the threshold for a merge decision. A false merge destroys stored data and a missed
 * merge costs a duplicate, so the no-false-merge threshold wins whenever one admits any true
 * pair, however much F1 it gives up. Best-F1 is the fallback only when none does.
 */
export function chooseThreshold(
  pos: readonly number[],
  neg: readonly number[],
): { point: ThresholdPoint; rule: 'no_false_merge' | 'best_f1' } {
  const best = bestF1(pos, neg);
  const safe = noFalseMerge(pos, neg);
  if (safe && safe.recall > 0) return { point: safe, rule: 'no_false_merge' };
  return { point: best, rule: 'best_f1' };
}

/** Lowest true score minus highest false score. Positive means one threshold separates them all. */
export function separationMargin(pos: readonly number[], neg: readonly number[]): number {
  return Math.min(...pos) - Math.max(...neg);
}

/** The grid value at or below which at most (1 - keep) of the true scores fall. */
export function keepFloor(pos: readonly number[], keep: number): number {
  const sorted = [...pos].sort((a, b) => a - b);
  const index = Math.floor((1 - keep) * sorted.length);
  const score = sorted[Math.min(index, sorted.length - 1)]!;
  // The epsilon keeps a score such as 0.57 from flooring to 0.56 through float error.
  return Math.floor(score * GRID_STEPS + 1e-9) / GRID_STEPS;
}

/** Mean recall@k and mean reciprocal rank, given each query's labels ranked best first. */
export function rankingMetrics(
  results: ReadonlyArray<{ ranked: readonly string[]; relevant: readonly string[] }>,
  k: number,
): { recallAtK: number; mrr: number } {
  let recall = 0;
  let reciprocal = 0;
  for (const { ranked, relevant } of results) {
    const top = ranked.slice(0, k);
    recall += relevant.filter(label => top.includes(label)).length / relevant.length;
    const firstHit = ranked.findIndex(label => relevant.includes(label));
    reciprocal += firstHit === -1 ? 0 : 1 / (firstHit + 1);
  }
  return { recallAtK: recall / results.length, mrr: reciprocal / results.length };
}

// -- Evaluation --

export interface PairTaskReport {
  auc: number;
  bestF1: ThresholdPoint;
  noFalseMerge: ThresholdPoint | undefined;
  chosen: { point: ThresholdPoint; rule: 'no_false_merge' | 'best_f1' };
  margin: number;
}

export interface WidthReport {
  width: number;
  entities: PairTaskReport & { ambiguityFloor: number };
  facts: PairTaskReport;
  search: { recallAtK: number; mrr: number };
  suggested: EmbeddingProfile['thresholds'];
}

function pairTask(pos: number[], neg: number[]): PairTaskReport {
  return {
    auc: rocAuc(pos, neg),
    bestF1: bestF1(pos, neg),
    noFalseMerge: noFalseMerge(pos, neg),
    chosen: chooseThreshold(pos, neg),
    margin: separationMargin(pos, neg),
  };
}

/**
 * Scores the fixture at each width. Each pair is embedded the way the service compares it:
 * the incoming label as `similarity` against the stored label as `document`, and a search
 * query as `query` against stored labels as `document`.
 */
export async function evaluate(
  fixture: EvalFixture,
  service: EmbeddingService,
  widths: readonly number[],
): Promise<WidthReport[]> {
  const wanted = new Map<string, { text: string; purpose: EmbeddingPurpose }>();
  const key = (text: string, purpose: EmbeddingPurpose) => `${purpose}\u0000${text}`;
  const want = (text: string, purpose: EmbeddingPurpose) => wanted.set(key(text, purpose), { text, purpose });
  for (const [a, b] of [...fixture.entities.match, ...fixture.entities.distinct, ...fixture.facts.merge, ...fixture.facts.distinct]) {
    want(a, 'similarity');
    want(b, 'document');
  }
  for (const label of fixture.search.corpus) want(label, 'document');
  for (const q of fixture.search.queries) want(q.query, 'query');

  const full = new Map<string, number[]>();
  const items = [...wanted.entries()];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(async ([k, { text, purpose }]) => {
      full.set(k, await service.embed(text, purpose));
    }));
  }

  return widths.map(width => {
    const vec = (text: string, purpose: EmbeddingPurpose) => truncateAndNormalize(full.get(key(text, purpose))!, width);
    const scores = (pairs: Pair[]) => pairs.map(([a, b]) => EmbeddingService.cosineSimilarity(vec(a, 'similarity'), vec(b, 'document')));

    const entityPos = scores(fixture.entities.match);
    const entities = { ...pairTask(entityPos, scores(fixture.entities.distinct)), ambiguityFloor: keepFloor(entityPos, FLOOR_KEEP) };
    const facts = pairTask(scores(fixture.facts.merge), scores(fixture.facts.distinct));

    const corpus = fixture.search.corpus.map(label => ({ label, v: vec(label, 'document') }));
    const search = rankingMetrics(fixture.search.queries.map(q => {
      const qv = vec(q.query, 'query');
      const ranked = corpus
        .map(c => ({ label: c.label, score: EmbeddingService.cosineSimilarity(qv, c.v) }))
        .sort((a, b) => b.score - a.score)
        .map(c => c.label);
      return { ranked, relevant: q.relevant };
    }), RECALL_AT);

    const fuzzyResolve = entities.chosen.point.threshold;
    return {
      width,
      entities,
      facts,
      search,
      suggested: {
        factDedup: facts.chosen.point.threshold,
        fuzzyResolve,
        // The floor must sit below the auto-resolve threshold, or nothing is ever ambiguous.
        fuzzyAmbiguityFloor: Math.min(entities.ambiguityFloor, Math.round((fuzzyResolve - 1 / GRID_STEPS) * GRID_STEPS) / GRID_STEPS),
      },
    };
  });
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function describePairTask(name: string, t: PairTaskReport): string[] {
  const safe = t.noFalseMerge
    ? `${t.noFalseMerge.threshold.toFixed(2)} (F1 ${fmt(t.noFalseMerge.f1)}, recall ${fmt(t.noFalseMerge.recall)})`
    : 'none on the grid';
  return [
    `  ${name}: ROC-AUC ${fmt(t.auc)}, separation margin ${fmt(t.margin)}`,
    `    best-F1 threshold ${t.bestF1.threshold.toFixed(2)} (F1 ${fmt(t.bestF1.f1)}, ${t.bestF1.falseMerges} false merge(s))`,
    `    no-false-merge threshold ${safe}`,
    `    chosen ${t.chosen.point.threshold.toFixed(2)} by ${t.chosen.rule === 'no_false_merge' ? 'no-false-merge' : 'best-F1'}`,
  ];
}

export function formatReport(model: string, prefixes: EmbeddingProfile['prefixes'], reports: readonly WidthReport[]): string {
  const lines = [`Model ${model}`, `Prefixes ${JSON.stringify(prefixes)}`, ''];
  for (const r of reports) {
    lines.push(`Width ${r.width}`);
    lines.push(...describePairTask('Entity resolution', r.entities));
    lines.push(`    ambiguity floor (keeps ${FLOOR_KEEP * 100}% of true pairs) ${r.entities.ambiguityFloor.toFixed(2)}`);
    lines.push(...describePairTask('Fact dedup', r.facts));
    lines.push(`  Search: recall@${RECALL_AT} ${fmt(r.search.recallAtK)}, MRR ${fmt(r.search.mrr)}`);
    lines.push(
      `  Suggested thresholds: fact_dedup ${r.suggested.factDedup.toFixed(2)}, ` +
      `fuzzy_resolve ${r.suggested.fuzzyResolve.toFixed(2)}, fuzzy_ambiguity_floor ${r.suggested.fuzzyAmbiguityFloor.toFixed(2)}`,
    );
    lines.push('');
  }
  return lines.join('\n');
}

// -- CLI --

export interface EvalArgs {
  baseUrl: string;
  model: string;
  keyEnv: string | undefined;
  widths: number[];
  prefixes: EmbeddingProfile['prefixes'];
  fixture: string;
}

export function parseArgs(argv: string[]): EvalArgs {
  const { values } = parseNodeArgs({
    args: argv.filter(a => a !== '--'),
    options: {
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'key-env': { type: 'string' },
      widths: { type: 'string' },
      'query-prefix': { type: 'string' },
      'document-prefix': { type: 'string' },
      'similarity-prefix': { type: 'string' },
      fixture: { type: 'string' },
    },
    strict: true,
  });
  const baseUrl = values['base-url'];
  const model = values.model;
  if (!baseUrl || !model) throw new Error('--base-url and --model are required');
  const widths = (values.widths ?? '').split(',').filter(Boolean).map(w => Number.parseInt(w, 10));
  if (widths.length === 0 || widths.some(w => !Number.isInteger(w) || w < 1)) {
    throw new Error(`--widths must be a comma-separated list of positive integers, got: ${values.widths ?? ''}`);
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    keyEnv: values['key-env'],
    widths,
    prefixes: {
      query: values['query-prefix'] ?? '',
      document: values['document-prefix'] ?? '',
      similarity: values['similarity-prefix'] ?? '',
    },
    fixture: values.fixture ?? DEFAULT_FIXTURE,
  };
}

const logger = pino({ name: 'embedding-eval', level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  let apiKey: string | undefined;
  if (args.keyEnv) {
    apiKey = process.env[args.keyEnv];
    if (!apiKey) {
      logger.error(`embedding-eval: --key-env names ${args.keyEnv}, which is not set`);
      return 1;
    }
  }
  const fixture = loadFixture(args.fixture);
  // Only the transport and the prefixes are used; the thresholds are what this run measures.
  const probe: EmbeddingProfile = {
    model: args.model,
    dimensions: Math.max(...args.widths),
    prefixes: args.prefixes,
    thresholds: OPENAI_TEXT_EMBEDDING_3_SMALL.thresholds,
  };
  const service = EmbeddingService.createWithEndpoint({ baseUrl: args.baseUrl, model: args.model, apiKey }, probe, logger);
  const reports = await evaluate(fixture, service, args.widths);
  process.stdout.write(formatReport(args.model, args.prefixes, reports) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      logger.error({ err }, 'embedding-eval: failed');
      process.exit(1);
    });
}
