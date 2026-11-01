// Force-directed layout for the Knowledge Graph view (ADR-058).
//
// Pure and synchronous so it can run in a Web Worker (kg-layout.worker.ts) and in tests.
// The page posts one request per render or expansion and gets every node's final centre
// back in a single message: the simulation never ticks through React state.
//
// The forces carry over the tuning of the fCoSE layout this replaced: facts sit close to
// their entity, strong relationships pull their pair together, stale or uncertain edges
// pull weakly, hub entity types push harder, and each node keeps a label-wide footprint.

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';

export interface LayoutNodeInput {
  id: string;
  type: string;
  decayClass: string;
  /** Rendered diameter in px. */
  size: number;
  /** Current centre, when the node is already on the canvas (expansion warm start). */
  x?: number;
  y?: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
  /** Relationship type, e.g. `reports_to`. */
  label: string;
  confidence: number;
}

export interface LayoutRequest {
  seq: number;
  /** `full`: lay out from scratch. `expand`: start from current positions; new nodes start by `anchorId`. */
  mode: 'full' | 'expand';
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  anchorId?: string;
}

export type LayoutResponse =
  | { seq: number; ok: true; positions: Record<string, { x: number; y: number }> }
  | { seq: number; ok: false; error: string };

// Edge types for close structural relationships; their pairs sit visually adjacent.
export const STRONG_EDGES = new Set([
  'spouse', 'parent', 'child', 'sibling',
  'reports_to', 'manages', 'member_of', 'founded', 'invested_in', 'advises',
]);

// Spring strength by how quickly the connected nodes go stale.
const DECAY_SCORE: Record<string, number> = {
  permanent: 1.0,
  slow_decay: 0.7,
  fast_decay: 0.4,
};

/** Labels are clipped to this width; the collision radius keeps neighbours' labels apart. */
export const LABEL_WIDTH = 90;

const FULL_TICKS = 300;
const EXPAND_TICKS = 150;
const EXPAND_ALPHA = 0.5;

interface SimNode extends SimulationNodeDatum {
  id: string;
  type: string;
  decayClass: string;
  size: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  label: string;
  confidence: number;
}

/** Repulsion: facts barely push (they cluster on their entity); hub types need room. */
export function chargeFor(type: string): number {
  if (type === 'fact') return -40;
  if (type === 'person' || type === 'organization' || type === 'event') return -320;
  return -220;
}

/** Rest length: facts hug their entity, strong pairs sit close, the rest settle at 150px. */
export function linkDistance(sourceType: string, targetType: string, label: string): number {
  if (sourceType === 'fact' || targetType === 'fact') return 70;
  if (STRONG_EDGES.has(label)) return 110;
  return 150;
}

/** Spring strength: strong pairs pull hard; otherwise confidence × the staler endpoint. */
export function linkStrength(label: string, confidence: number, sourceDecay: string, targetDecay: string): number {
  if (STRONG_EDGES.has(label)) return 0.9;
  const s = DECAY_SCORE[sourceDecay] ?? 0.7;
  const t = DECAY_SCORE[targetDecay] ?? 0.7;
  return Math.max(0.1, confidence * Math.min(s, t) * 0.7);
}

/** Footprint: facts hide their label, so only the dot counts; others reserve label width. */
export function collisionRadius(type: string, size: number): number {
  if (type === 'fact') return size / 2 + 4;
  return Math.max(size / 2 + 8, LABEL_WIDTH / 2);
}

// Deterministic randomness (same graph, same picture) for d3's jiggle and new-node scatter.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function computeLayout(req: LayoutRequest): LayoutResponse {
  const rand = lcg(0x6b67);
  const known = new Map(req.nodes.filter(n => n.x !== undefined && n.y !== undefined).map(n => [n.id, n]));
  const anchor = req.anchorId ? known.get(req.anchorId) : undefined;

  const nodes: SimNode[] = req.nodes.map(n => {
    const sim: SimNode = { id: n.id, type: n.type, decayClass: n.decayClass, size: n.size };
    if (req.mode === 'expand') {
      if (n.x !== undefined && n.y !== undefined) {
        sim.x = n.x; sim.y = n.y;
      } else {
        // New node: start in a small ring around the node that was expanded.
        const a = rand() * Math.PI * 2;
        const r = 40 + rand() * 40;
        sim.x = (anchor?.x ?? 0) + Math.cos(a) * r;
        sim.y = (anchor?.y ?? 0) + Math.sin(a) * r;
      }
    }
    // `full`: no start position, so d3 places nodes on its deterministic phyllotaxis spiral.
    return sim;
  });

  const byId = new Map(nodes.map(n => [n.id, n]));
  const links: SimLink[] = req.edges
    .filter(e => byId.has(e.source) && byId.has(e.target) && e.source !== e.target)
    .map(e => ({ source: e.source, target: e.target, label: e.label, confidence: e.confidence }));

  const endType = (end: SimLink['source']) => (typeof end === 'object' ? end.type : byId.get(String(end))?.type ?? '');
  const endDecay = (end: SimLink['source']) => (typeof end === 'object' ? end.decayClass : byId.get(String(end))?.decayClass ?? '');

  const sim = forceSimulation<SimNode, SimLink>(nodes)
    .randomSource(rand)
    .force('link', forceLink<SimNode, SimLink>(links)
      .id(n => n.id)
      .distance(l => linkDistance(endType(l.source), endType(l.target), l.label))
      .strength(l => linkStrength(l.label, l.confidence, endDecay(l.source), endDecay(l.target))))
    .force('charge', forceManyBody<SimNode>().strength(n => chargeFor(n.type)).distanceMax(800))
    .force('collide', forceCollide<SimNode>(n => collisionRadius(n.type, n.size)).strength(0.85).iterations(1))
    // Weak gravity so separate components drift apart instead of being pulled into a ball.
    .force('x', forceX<SimNode>(0).strength(0.03))
    .force('y', forceY<SimNode>(0).strength(0.03))
    .stop();

  if (req.mode === 'expand') sim.alpha(EXPAND_ALPHA);
  sim.tick(req.mode === 'expand' ? EXPAND_TICKS : FULL_TICKS);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) positions[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
  return { seq: req.seq, ok: true, positions };
}
