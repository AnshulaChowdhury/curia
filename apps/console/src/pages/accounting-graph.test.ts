import { describe, expect, it } from 'vitest';
import { applyPositions, modelFrom } from './kg-graph-model.js';
import { matchesText, neighbours, nodeRows, normaliseSnapshot, subModel, typeCounts, typeLabel, visibleIds } from './accounting-graph.js';
import type { AccountingGraphResponse } from './accounting-graph.js';

const response = (): AccountingGraphResponse => ({
  received_at: '2026-11-02T12:00:00Z',
  snapshot: {
    generated_at: '2026-11-02T12:00:00Z',
    nodes: [
      { id: 'rule:cat-canva', type: 'rule', label: 'cat-020-software-canva', properties: { ruleKind: 'category', status: 'confirmed', order: 20, pattern: 'CANVA', confirmedBy: 'anshula', note: 'Design tool' }, confidence: 1 },
      { id: 'category:Software', type: 'category', label: 'Software subscriptions' },
      { id: 'payee:Canva', type: 'payee', label: 'Canva' },
      { id: 'tax:HST ON', type: 'tax_code', label: 'HST ON' },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'rule:cat-canva', targetNodeId: 'category:Software', type: 'assigns', confidence: 1 },
      { id: 'e2', sourceNodeId: 'rule:cat-canva', targetNodeId: 'payee:Canva', type: 'assigns' },
    ],
  },
});

const build = () => {
  const m = modelFrom(normaliseSnapshot(response()));
  applyPositions(m, { 'rule:cat-canva': { x: 0, y: 0 }, 'category:Software': { x: 50, y: 0 }, 'payee:Canva': { x: 0, y: 50 }, 'tax:HST ON': { x: 90, y: 90 } });
  return m;
};

describe('normaliseSnapshot', () => {
  it('fills in the fields the shared canvas code expects', () => {
    const { nodes, edges } = normaliseSnapshot(response());
    expect(nodes[1]).toMatchObject({ confidence: 1, decayClass: 'permanent', sensitivity: 'internal', properties: {}, aliases: [] });
    expect(edges[1]).toMatchObject({ id: 'e2', confidence: 1 });
  });

  it('is empty without a snapshot', () => {
    expect(normaliseSnapshot({ empty: true })).toEqual({ nodes: [], edges: [] });
  });
});

describe('text filter', () => {
  it('matches the label, id, type name and any text property, ignoring case', () => {
    const [rule, cat] = normaliseSnapshot(response()).nodes;
    expect(matchesText(rule!, 'canva')).toBe(true);
    expect(matchesText(rule!, 'DESIGN TOOL')).toBe(true);      // note property
    expect(matchesText(cat!, 'subscriptions')).toBe(true);
    expect(matchesText(cat!, 'account')).toBe(true);           // the type's display name
    expect(matchesText(cat!, 'nothing like this')).toBe(false);
    expect(matchesText(cat!, '   ')).toBe(true);
  });

  it('shows matches and their neighbours, and everything when the text is empty', () => {
    const m = build();
    expect(visibleIds(m, '')).toBeNull();
    expect([...visibleIds(m, 'subscriptions')!].sort()).toEqual(['category:Software', 'rule:cat-canva']);
    expect([...visibleIds(m, 'canva')!].sort()).toEqual(['category:Software', 'payee:Canva', 'rule:cat-canva']);
    expect(visibleIds(m, 'zzz')!.size).toBe(0);
  });

  it('keeps positions and drops edges whose ends are not both shown', () => {
    const m = build();
    const sub = subModel(m, visibleIds(m, 'subscriptions')!);
    expect([...sub.nodes.keys()].sort()).toEqual(['category:Software', 'rule:cat-canva']);
    expect([...sub.edges.keys()]).toEqual(['e1']);
    expect(sub.pos.get('category:Software')).toEqual({ x: 50, y: 0 });
  });
});

describe('facts for the panel', () => {
  it('counts by type with readable names', () => {
    expect(typeCounts(build())).toEqual([
      { value: 'category', count: 1 }, { value: 'payee', count: 1 }, { value: 'rule', count: 1 }, { value: 'tax_code', count: 1 },
    ]);
    expect(typeLabel('bank_account')).toBe('Bank account');
    expect(typeLabel('mystery')).toBe('mystery');
  });

  it('lists known properties first in a fixed order, then the rest, as plain text', () => {
    const rows = nodeRows(normaliseSnapshot(response()).nodes[0]!);
    expect(rows.map(r => r.label)).toEqual(['Kind', 'Id', 'Rule kind', 'Status', 'Order', 'Matches text', 'Confirmed by', 'Note']);
    expect(rows.find(r => r.label === 'Order')!.value).toBe('20');
    const odd = nodeRows({ ...normaliseSnapshot(response()).nodes[1]!, properties: { zeta: 'z', alpha: { a: 1 }, empty: '' } });
    expect(odd.map(r => r.label)).toEqual(['Kind', 'Id', 'alpha', 'zeta']);
    expect(odd[2]!.value).toBe('{"a":1}');
  });

  it('lists connections with their direction, sorted', () => {
    const m = build();
    expect(neighbours(m, 'rule:cat-canva').map(n => `${n.relation}:${n.direction}:${n.label}`)).toEqual(['assigns:out:Canva', 'assigns:out:Software subscriptions']);
    expect(neighbours(m, 'category:Software')).toEqual([{ id: 'rule:cat-canva', label: 'cat-020-software-canva', type: 'rule', relation: 'assigns', direction: 'in' }]);
    expect(neighbours(m, 'tax:HST ON')).toEqual([]);
  });
});
