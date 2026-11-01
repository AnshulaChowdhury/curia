import { describe, expect, it } from 'vitest';
import {
  chargeFor, collisionRadius, computeLayout, LABEL_WIDTH, linkDistance, linkStrength,
} from './kg-layout.js';
import type { LayoutRequest } from './kg-layout.js';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function star(): LayoutRequest {
  // A person hub with a fact, a strong relation and a generic relation.
  return {
    seq: 1,
    mode: 'full',
    nodes: [
      { id: 'hub', type: 'person', decayClass: 'permanent', size: 40 },
      { id: 'fact', type: 'fact', decayClass: 'permanent', size: 10 },
      { id: 'boss', type: 'person', decayClass: 'permanent', size: 24 },
      { id: 'proj', type: 'project', decayClass: 'permanent', size: 24 },
    ],
    edges: [
      { source: 'hub', target: 'fact', label: 'has_fact', confidence: 0.9 },
      { source: 'hub', target: 'boss', label: 'reports_to', confidence: 0.9 },
      { source: 'hub', target: 'proj', label: 'works_on', confidence: 0.9 },
    ],
  };
}

describe('kg-layout tuning', () => {
  it('keeps facts close, strong pairs closer than generic edges', () => {
    expect(linkDistance('fact', 'person', 'x')).toBe(70);
    expect(linkDistance('person', 'person', 'reports_to')).toBe(110);
    expect(linkDistance('person', 'project', 'works_on')).toBe(150);
  });

  it('weights springs by strength, confidence and the staler endpoint', () => {
    expect(linkStrength('spouse', 0.1, 'fast_decay', 'fast_decay')).toBe(0.9);
    expect(linkStrength('knows', 1, 'permanent', 'fast_decay')).toBeCloseTo(0.28);
    expect(linkStrength('knows', 0, 'permanent', 'permanent')).toBe(0.1);
  });

  it('gives hubs more repulsion than facts', () => {
    expect(chargeFor('person')).toBeLessThan(chargeFor('project'));
    expect(chargeFor('project')).toBeLessThan(chargeFor('fact'));
  });

  it('reserves label width for labelled nodes only', () => {
    expect(collisionRadius('person', 20)).toBe(LABEL_WIDTH / 2);
    expect(collisionRadius('person', 80)).toBe(48);
    expect(collisionRadius('fact', 10)).toBe(9);
  });
});

describe('computeLayout', () => {
  it('returns a finite position for every node, echoing the request seq', () => {
    const res = computeLayout({ ...star(), seq: 7 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.seq).toBe(7);
    expect(Object.keys(res.positions).sort()).toEqual(['boss', 'fact', 'hub', 'proj']);
    for (const p of Object.values(res.positions)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(computeLayout(star())).toEqual(computeLayout(star()));
  });

  it('settles the fact nearer its entity than a generic neighbour', () => {
    const res = computeLayout(star());
    if (!res.ok) throw new Error(res.error);
    const p = res.positions;
    expect(dist(p['hub']!, p['fact']!)).toBeLessThan(dist(p['hub']!, p['proj']!));
  });

  it('expansion keeps existing nodes near where they were and places new ones by the anchor', () => {
    const req = star();
    const res: LayoutRequest = {
      ...req,
      mode: 'expand',
      anchorId: 'proj',
      nodes: [
        { ...req.nodes[0]!, x: 0, y: 0 },
        { ...req.nodes[1]!, x: 60, y: 0 },
        { ...req.nodes[2]!, x: -110, y: 0 },
        { ...req.nodes[3]!, x: 0, y: 400 },
        { id: 'new', type: 'person', decayClass: 'permanent', size: 20 },
      ],
      edges: [...req.edges, { source: 'proj', target: 'new', label: 'member_of', confidence: 0.9 }],
    };
    const out = computeLayout(res);
    if (!out.ok) throw new Error(out.error);
    expect(dist(out.positions['hub']!, { x: 0, y: 0 })).toBeLessThan(150);
    expect(dist(out.positions['new']!, out.positions['proj']!)).toBeLessThan(dist(out.positions['new']!, out.positions['hub']!));
  });

  it('ignores edges to nodes not in the request', () => {
    const req = star();
    const res = computeLayout({ ...req, edges: [...req.edges, { source: 'hub', target: 'ghost', label: 'x', confidence: 1 }] });
    expect(res.ok).toBe(true);
  });
});
