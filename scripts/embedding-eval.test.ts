import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_FIXTURE,
  bestF1,
  chooseThreshold,
  keepFloor,
  loadFixture,
  noFalseMerge,
  rankingMetrics,
  rocAuc,
  scoreAt,
  separationMargin,
} from './embedding-eval.js';

describe('rocAuc', () => {
  it('is 1 when every true pair outscores every false pair', () => {
    expect(rocAuc([0.9, 0.8], [0.5, 0.4])).toBe(1);
  });

  it('counts ties as half and inversions as zero', () => {
    // pairs: (0.6>0.5)=1, (0.6=0.6)=0.5, (0.4<0.5)=0, (0.4<0.6)=0
    expect(rocAuc([0.6, 0.4], [0.5, 0.6])).toBe(0.375);
  });
});

describe('thresholds', () => {
  const pos = [0.95, 0.9, 0.85, 0.7];
  const neg = [0.8, 0.6, 0.5];

  it('scores a threshold as merging everything at or above it', () => {
    const point = scoreAt(pos, neg, 0.8);
    expect(point.falseMerges).toBe(1);
    expect(point.recall).toBe(0.75);
    expect(point.precision).toBe(0.75);
  });

  it('finds the lowest grid threshold with no false merge', () => {
    const point = noFalseMerge(pos, neg)!;
    expect(point.threshold).toBe(0.81);
    expect(point.falseMerges).toBe(0);
    expect(point.recall).toBe(0.75);
  });

  it('returns undefined when no grid threshold avoids a false merge', () => {
    expect(noFalseMerge([0.9], [1])).toBeUndefined();
  });

  it('breaks a best-F1 tie towards the higher threshold', () => {
    // Every threshold in (0.6, 0.7] gives the same F1; the highest is 0.70.
    expect(bestF1([0.9, 0.7], [0.6]).threshold).toBe(0.7);
  });

  it('prefers no-false-merge when it admits a true pair', () => {
    const chosen = chooseThreshold(pos, neg);
    expect(chosen.rule).toBe('no_false_merge');
    expect(chosen.point.threshold).toBe(0.81);
  });

  it('keeps no-false-merge even when best-F1 is far ahead', () => {
    // One false pair scores above all but one true pair: F1 0.40 against 0.89.
    const chosen = chooseThreshold([0.99, 0.8, 0.8, 0.8], [0.9, 0.1]);
    expect(chosen.rule).toBe('no_false_merge');
    expect(chosen.point.threshold).toBe(0.91);
  });

  it('falls back to best-F1 when no threshold admits a true pair without a false one', () => {
    const chosen = chooseThreshold([0.8, 0.7], [0.9, 0.1]);
    expect(chosen.rule).toBe('best_f1');
    expect(chosen.point.threshold).toBe(0.7);
  });

  it('reports the separation margin, negative when the sets overlap', () => {
    expect(separationMargin(pos, neg)).toBeCloseTo(-0.1);
    expect(separationMargin([0.9], [0.7])).toBeCloseTo(0.2);
  });

  it('sets the floor where the given share of true scores stays above it', () => {
    const scores = Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.02); // 0.50 .. 0.88
    expect(keepFloor(scores, 0.95)).toBe(0.52);
  });
});

describe('rankingMetrics', () => {
  it('averages recall@k and reciprocal rank over queries', () => {
    const metrics = rankingMetrics([
      { ranked: ['a', 'b', 'c'], relevant: ['a'] },        // recall 1, RR 1
      { ranked: ['x', 'y', 'b', 'z'], relevant: ['b', 'q'] }, // recall 0.5, RR 1/3
      { ranked: ['x', 'y', 'z'], relevant: ['w'] },        // recall 0, RR 0
    ], 3);
    expect(metrics.recallAtK).toBeCloseTo(0.5);
    expect(metrics.mrr).toBeCloseTo((1 + 1 / 3) / 3);
  });
});

describe('loadFixture', () => {
  it('loads the shipped fixture', () => {
    const fixture = loadFixture(DEFAULT_FIXTURE);
    expect(fixture.entities.match.length).toBeGreaterThan(20);
    expect(fixture.facts.distinct.length).toBeGreaterThan(20);
    expect(fixture.search.queries.length).toBeGreaterThan(10);
  });

  it('rejects a query whose relevant label is not in the corpus', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'embedding-eval-')), 'bad.json');
    writeFileSync(file, JSON.stringify({
      entities: { match: [], distinct: [] },
      facts: { merge: [], distinct: [] },
      search: { corpus: ['a'], queries: [{ query: 'q', relevant: ['missing'] }] },
    }));
    expect(() => loadFixture(file)).toThrow(/missing from search.corpus/);
  });
});
