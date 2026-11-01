import { describe, expect, it } from 'vitest';
import {
  addToModel, applyPositions, buildFlow, closedNeighborhood, colorClass, degrees, drawerNode, emptyFlowCache,
  graphStatus, layoutRequest, modelFrom, nodeSize, removeNode, swatchClass,
} from './kg-graph-model.js';
import type { ApiKgEdge, FlowOptions } from './kg-graph-model.js';
import { emptyFilter, toggleFilterValue } from './kg-filters.js';
import type { ApiKgNode } from './kg-types.js';

function node(id: string, type = 'person', extra: Partial<ApiKgNode> = {}): ApiKgNode {
  return {
    id, label: id.toUpperCase(), type, confidence: 0.8, decayClass: 'permanent', sensitivity: 'internal',
    properties: {}, source: '', createdAt: '', lastConfirmedAt: '', ...extra,
  };
}
const edge = (id: string, s: string, t: string, type = 'knows'): ApiKgEdge => ({ id, sourceNodeId: s, targetNodeId: t, type, confidence: 0.6 });

function sample() {
  const m = modelFrom({
    nodes: [node('a'), node('b', 'project'), node('f', 'fact', { sensitivity: 'restricted' })],
    edges: [edge('ab', 'a', 'b'), edge('af', 'a', 'f'), edge('ax', 'a', 'missing')],
  });
  applyPositions(m, { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, f: { x: 0, y: 50 } });
  return m;
}

const opts = (o: Partial<FlowOptions> = {}): FlowOptions => ({ colorMode: 'type', filter: emptyFilter(), focalId: null, selectedId: null, ...o });

describe('model', () => {
  it('counts degrees on live edges only', () => {
    const d = degrees(sample());
    expect(d.get('a')).toBe(2);
    expect(d.get('b')).toBe(1);
  });

  it('adds only what is new and removes a node with its edges', () => {
    const m = sample();
    expect(addToModel(m, { nodes: [node('a'), node('c')], edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')] }))
      .toEqual({ nodes: 1, edges: 1 });
    removeNode(m, 'b');
    expect(m.nodes.has('b')).toBe(false);
    expect([...m.edges.keys()].sort()).toEqual(['af', 'ax']);
    expect(m.pos.has('b')).toBe(false);
  });

  it('finds the closed neighbourhood', () => {
    expect(closedNeighborhood(sample(), 'a').sort()).toEqual(['a', 'b', 'f']);
  });

  it('reports counts and filtered nodes in the status line', () => {
    const m = sample();
    expect(graphStatus(m, emptyFilter())).toBe('3 nodes · 2 edges');
    const f = toggleFilterValue(emptyFilter(), 'types', 'person');
    expect(graphStatus(m, f)).toBe('3 nodes · 2 edges · 2 hidden by filters');
  });

  it('fills drawer defaults like the old canvas did', () => {
    const n = drawerNode({ ...node('z'), decayClass: '', sensitivity: '' });
    expect(n.decayClass).toBe('permanent');
    expect(n.sensitivity).not.toBe('');
  });
});

describe('appearance', () => {
  it('sizes by degree from 14px to 56px; facts are fixed', () => {
    expect(nodeSize('person', 0)).toBe(14);
    expect(nodeSize('person', 15)).toBe(56);
    expect(nodeSize('person', 40)).toBe(56);
    expect(nodeSize('fact', 30)).toBe(8);
  });

  it('colours by type, sensitivity or decay, with an "other" fallback', () => {
    expect(colorClass(node('a'), 'type')).toBe('kg-c-type-person');
    expect(colorClass(node('a', 'mystery'), 'type')).toBe('kg-c-type-other');
    expect(colorClass(node('a', 'person', { sensitivity: 'secret' }), 'sensitivity')).toBe('kg-c-sens-other');
    expect(colorClass(node('a', 'person', { decayClass: 'fast_decay' }), 'decay')).toBe('kg-c-decay-fast_decay');
  });
});

describe('swatchClass', () => {
  it('matches the canvas colour classes, with an "other" fallback', () => {
    expect(swatchClass('types', 'person')).toBe(colorClass(node('a'), 'type'));
    expect(swatchClass('sensitivities', 'restricted')).toBe('kg-c-sens-restricted');
    expect(swatchClass('types', 'mystery')).toBe('kg-c-type-other');
  });
});

describe('buildFlow', () => {
  it('centres nodes on their positions and skips nodes not laid out yet', () => {
    const m = sample();
    m.nodes.set('late', node('late'));
    const { nodes, edges } = buildFlow(m, opts(), emptyFlowCache());
    expect(nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'f']);
    const a = nodes.find(n => n.id === 'a')!;
    expect(a.position).toEqual({ x: -a.data.size / 2, y: -a.data.size / 2 });
    expect(edges.map(e => e.id).sort()).toEqual(['ab', 'af']);
  });

  it('hides filtered nodes and every edge touching them', () => {
    const f = toggleFilterValue(emptyFilter(), 'sensitivities', 'internal');
    const { nodes, edges } = buildFlow(sample(), opts({ filter: f }), emptyFlowCache());
    expect(nodes.find(n => n.id === 'f')!.hidden).toBe(true);
    expect(nodes.find(n => n.id === 'a')!.hidden).toBe(false);
    expect(edges.find(e => e.id === 'af')!.hidden).toBe(true);
    expect(edges.find(e => e.id === 'ab')!.hidden).toBe(false);
  });

  it('brings the focal node\'s edges forward with their labels; others stay quiet', () => {
    const { edges } = buildFlow(sample(), opts({ focalId: 'b' }), emptyFlowCache());
    const ab = edges.find(e => e.id === 'ab')!;
    const af = edges.find(e => e.id === 'af')!;
    expect(ab.data!.focal).toBe(true);
    expect(ab.className).toBe('is-focal-edge');
    expect(ab.data!.labelAt).toBe(0.4); // b is the target: label sits nearer a
    expect(af.data!.focal).toBe(false);
    expect(af.data!.labelAt).toBeNull();
    expect(af.className).toBeUndefined();
    expect(Number(ab.style!.opacity)).toBeGreaterThan(Number(af.style!.opacity));
  });

  it('reuses unchanged node objects so memoised nodes skip re-rendering', () => {
    const m = sample();
    const cache = emptyFlowCache();
    const first = buildFlow(m, opts(), cache);
    const second = buildFlow(m, opts({ focalId: 'b' }), cache);
    const pick = (r: typeof first, id: string) => r.nodes.find(n => n.id === id);
    expect(pick(second, 'a')).toBe(pick(first, 'a'));
    expect(pick(second, 'b')).not.toBe(pick(first, 'b'));
    expect(pick(second, 'b')!.data.focal).toBe(true);
  });
});

describe('layoutRequest', () => {
  it('sends current positions only when expanding', () => {
    const m = sample();
    expect(layoutRequest(m, 1, 'full').nodes.every(n => n.x === undefined)).toBe(true);
    const exp = layoutRequest(m, 2, 'expand', 'a');
    expect(exp.anchorId).toBe('a');
    expect(exp.nodes.find(n => n.id === 'b')).toMatchObject({ x: 100, y: 0 });
    expect(exp.edges).toHaveLength(2);
  });
});
