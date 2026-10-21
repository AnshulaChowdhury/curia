// Executor invariants (#2233): every statement must touch exactly the rows the plan names,
// and the absorbed node is never archived with a contact still pointing at it. Driven by a
// scripted fake client — the real SQL is covered by tests/integration/kg-node-merge.test.ts.
import { describe, it, expect, vi } from 'vitest';
import type { DbPoolClient } from '../../../src/db/connection.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { Logger } from '../../../src/logger.js';
import { executeMerge, MergeInvariantError } from '../../../src/kg-merge/executor.js';
import { isUsableEmbedding } from '../../../src/kg-merge/service.js';
import { EMBEDDING_DIMENSIONS } from '../../../src/memory/types.js';
import type { ExecutionPlan } from '../../../src/kg-merge/types.js';
import { A_ID, S_ID, uid } from './fixtures.js';

const NOW = '2026-10-21T12:00:00.000Z';

function basePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    survivorId: S_ID,
    absorbedId: A_ID,
    mergedAt: NOW,
    survivor: { id: S_ID, type: 'person', label: 'Jane' },
    absorbed: { id: A_ID, type: 'person', label: 'J.' },
    crossType: false,
    node: {
      label: 'Jane', labelChanged: false, aliases: ['j.'], properties: {}, confidence: 0.7,
      decayClass: 'slow_decay', sensitivity: 'internal', createdAt: NOW, lastConfirmedAt: NOW,
      warnedAt: null, warnReason: null, identitySource: 'label',
    },
    facts: { deleteFactIds: [], relinkEdgeIds: [], deleteLinkEdgeIds: [], updates: [], movedFactCount: 0, collapsedFactCount: 0 },
    edges: { deleteEdgeIds: [], collapses: [], moveEdgeIds: [] },
    contacts: {
      action: 'none', survivingContactId: null, repoints: [], merges: [], mergedRow: null,
      mergedContactIds: [], repointedContactIds: [], survivingIsPrincipal: false,
    },
    summary: { factsMoved: 0, factsCollapsed: 0, edgesMoved: 0, edgesCollapsed: 0, edgesDropped: 0, conflictsResolved: 0 },
    resolutions: { label: 'survivor', properties: {}, facts: {}, nearDuplicateFacts: {}, contactFields: {}, authOverrides: {}, acknowledgements: [] },
    ...overrides,
  };
}

const survivorRow = {
  id: S_ID, type: 'person', label: 'Jane', properties: {}, embedding: null, confidence: 0.7,
  decay_class: 'slow_decay', source: 'test', sensitivity: 'internal', created_at: new Date(NOW),
  last_confirmed_at: new Date(NOW), archived_at: null, warned_at: null, warn_reason: null,
  aliases: ['j.'], identity_source: 'label',
};

/**
 * A client whose every statement succeeds with the "right" row count for the given plan,
 * except where `script` overrides a statement (matched by a SQL substring).
 */
function fakeClient(script: { match: RegExp; rows?: unknown[]; rowCount: number }[] = []) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const scripted = script.find(s => s.match.test(sql));
    if (scripted) return { rows: scripted.rows ?? [], rowCount: scripted.rowCount };
    if (/SELECT count\(\*\)/.test(sql)) return { rows: [{ count: '0' }], rowCount: 1 };
    if (/SELECT id FROM contacts WHERE kg_node_id/.test(sql)) return { rows: [], rowCount: 0 };
    if (/RETURNING/.test(sql)) return { rows: [survivorRow], rowCount: 1 };
    const ids = Array.isArray(params?.[0]) ? (params[0] as unknown[]).length : 1;
    return { rows: [], rowCount: ids };
  });
  return { client: { query } as unknown as DbPoolClient, query };
}

const logger = { child: () => logger, debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
const deps = { contactService: {} as ContactService, logger };

describe('executeMerge — invariants', () => {
  it('runs a consistent plan to the survivor update', async () => {
    const { client } = fakeClient();
    const plan = basePlan({ edges: { deleteEdgeIds: [uid(200)], collapses: [], moveEdgeIds: [uid(201), uid(202)] } });
    await expect(executeMerge(client, plan, null, deps)).resolves.toMatchObject({ node: { id: S_ID } });
  });

  it.each([
    ['a fact delete', /DELETE FROM kg_nodes/, basePlan({ facts: { ...basePlan().facts, deleteFactIds: [uid(100), uid(101)] } })],
    ['a fact update', /UPDATE kg_nodes\s+SET confidence/, basePlan({
      facts: { ...basePlan().facts, updates: [{ id: uid(100), confidence: 1, lastConfirmedAt: NOW, sensitivity: 'internal', properties: {} }] },
    })],
    ['a fact re-link', /UPDATE kg_edges\s+SET source_node_id/, basePlan({ facts: { ...basePlan().facts, relinkEdgeIds: [uid(300)] } })],
    ['a shared link delete', /DELETE FROM kg_edges/, basePlan({ facts: { ...basePlan().facts, deleteLinkEdgeIds: [uid(301)] } })],
    ['an edge move', /UPDATE kg_edges\s+SET source_node_id/, basePlan({ edges: { deleteEdgeIds: [], collapses: [], moveEdgeIds: [uid(201), uid(202)] } })],
    ['an edge collapse', /UPDATE kg_edges\s+SET confidence/, basePlan({
      edges: {
        deleteEdgeIds: [], moveEdgeIds: [],
        collapses: [{ survivorEdgeId: uid(203), absorbedEdgeId: uid(204), confidence: 1, lastConfirmedAt: NOW, decayClass: 'permanent', properties: {} }],
      },
    })],
    ['a contact re-point', /UPDATE contacts SET kg_node_id/, basePlan({
      contacts: { ...basePlan().contacts, action: 'repoint', repoints: [{ contactId: uid(10), kind: 'person' }], repointedContactIds: [uid(10)] },
    })],
    ['the archive', /SET archived_at = now\(\)/, basePlan()],
  ])('throws and stops when %s touches fewer rows than planned', async (_what, match, plan) => {
    const { client, query } = fakeClient([{ match, rowCount: 0 }]);
    await expect(executeMerge(client, plan, null, deps)).rejects.toBeInstanceOf(MergeInvariantError);
    // Nothing after the failed statement ran — the survivor was never updated.
    expect(query.mock.calls.some(([sql]) => /RETURNING/.test(String(sql)))).toBe(false);
  });

  it('refuses to archive the absorbed node while a contact still points at it', async () => {
    const { client, query } = fakeClient([{ match: /SELECT id FROM contacts WHERE kg_node_id/, rows: [{ id: uid(10) }], rowCount: 1 }]);
    await expect(executeMerge(client, basePlan(), null, deps)).rejects.toThrow(/still linked to the absorbed node/);
    expect(query.mock.calls.some(([sql]) => /archived_at = now\(\)/.test(String(sql)))).toBe(false);
  });

  it('refuses planned contact folds with no surviving contact or merged row', async () => {
    const { client } = fakeClient();
    const plan = basePlan({
      contacts: { ...basePlan().contacts, action: 'merge', merges: [{ secondaryId: uid(11), overridesPreferSecondary: [] }], mergedContactIds: [uid(11)] },
    });
    await expect(executeMerge(client, plan, null, deps)).rejects.toBeInstanceOf(MergeInvariantError);
  });
});

describe('isUsableEmbedding', () => {
  it('accepts only a finite vector of the column’s dimension', () => {
    expect(isUsableEmbedding(new Array(EMBEDDING_DIMENSIONS).fill(0.1))).toBe(true);
    expect(isUsableEmbedding(new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1))).toBe(false);
    expect(isUsableEmbedding([...new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1), Number.NaN])).toBe(false);
    expect(isUsableEmbedding([...new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1), Infinity])).toBe(false);
    expect(isUsableEmbedding([...new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1), '0.1'])).toBe(false);
    expect(isUsableEmbedding(null)).toBe(false);
    expect(isUsableEmbedding('[0.1]')).toBe(false);
  });
});
