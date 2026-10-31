// scripts/repair-config-store-labels.test.ts
//
// Unit tests for the config-store label repair (#2252).

import { describe, it, expect, vi } from 'vitest';
import {
  runRepair,
  formatRepairReport,
  parseMismatchRows,
  parseDuplicateRows,
  LIST_MISMATCHED_SQL,
  LIST_DUPLICATE_KEYS_SQL,
  APPLY_BY_IDS_SQL,
} from './repair-config-store-labels.js';

type MockPool = { query: ReturnType<typeof vi.fn> };

function makePool(
  listRows: unknown[],
  dupRows: unknown[] = [],
  applyRowCount = 0,
): MockPool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql === LIST_MISMATCHED_SQL) {
        return Promise.resolve({ rows: listRows });
      }
      if (sql === LIST_DUPLICATE_KEYS_SQL) {
        return Promise.resolve({ rows: dupRows });
      }
      if (sql === APPLY_BY_IDS_SQL) {
        return Promise.resolve({ rows: [], rowCount: applyRowCount });
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }),
  };
}

const SAMPLE_ROWS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    anchor_labels: ['config:travel_detection'],
    label: 'processed_event_ids_1',
    key: 'processed_event_ids_3',
    value_preview: '["e1","e2"]',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    anchor_labels: ['config:debrief'],
    label: 'seen:04ncurue_20260921T213000Z',
    key: 'seen:04ncurue_20261019T213000Z',
    value_preview: '1',
  },
];

const SAMPLE_DUP_ROWS = [
  {
    anchor_label: 'config:travel_detection',
    key: 'processed_event_ids_3',
    facts: [
      {
        id: '33333333-3333-3333-3333-333333333333',
        label: 'processed_event_ids_3',
        last_confirmed_at: '2026-10-20T12:00:00.000Z',
        value_preview: '["e3"]',
      },
      {
        id: '11111111-1111-1111-1111-111111111111',
        label: 'processed_event_ids_1',
        last_confirmed_at: '2026-10-01T12:00:00.000Z',
        value_preview: '["e1","e2"]',
      },
    ],
  },
];

describe('parseMismatchRows', () => {
  it('maps SQL columns to the report shape', () => {
    expect(parseMismatchRows(SAMPLE_ROWS)).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        anchorLabels: ['config:travel_detection'],
        label: 'processed_event_ids_1',
        key: 'processed_event_ids_3',
        valuePreview: '["e1","e2"]',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        anchorLabels: ['config:debrief'],
        label: 'seen:04ncurue_20260921T213000Z',
        key: 'seen:04ncurue_20261019T213000Z',
        valuePreview: '1',
      },
    ]);
  });

  it('throws when a required column is missing', () => {
    expect(() => parseMismatchRows([{ id: 'x' }])).toThrow(/anchor_labels/);
  });
});

describe('parseDuplicateRows', () => {
  it('maps duplicate-key groups with ordered facts', () => {
    expect(parseDuplicateRows(SAMPLE_DUP_ROWS)).toEqual([
      {
        anchorLabel: 'config:travel_detection',
        key: 'processed_event_ids_3',
        facts: [
          {
            id: '33333333-3333-3333-3333-333333333333',
            label: 'processed_event_ids_3',
            lastConfirmedAt: '2026-10-20T12:00:00.000Z',
            valuePreview: '["e3"]',
          },
          {
            id: '11111111-1111-1111-1111-111111111111',
            label: 'processed_event_ids_1',
            lastConfirmedAt: '2026-10-01T12:00:00.000Z',
            valuePreview: '["e1","e2"]',
          },
        ],
      },
    ]);
  });

  it('accepts facts as a JSON string (pg driver variants)', () => {
    const row = {
      anchor_label: 'config:ns',
      key: 'k',
      facts: JSON.stringify([
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          label: 'k',
          last_confirmed_at: '2026-01-01T00:00:00.000Z',
          value_preview: 'v',
        },
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          label: 'old',
          last_confirmed_at: '2025-01-01T00:00:00.000Z',
          value_preview: 'old',
        },
      ]),
    };
    const parsed = parseDuplicateRows([row]);
    expect(parsed[0]!.facts).toHaveLength(2);
    expect(parsed[0]!.facts[0]!.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});

describe('runRepair', () => {
  it('dry-run lists mismatches and duplicates and writes nothing', async () => {
    const pool = makePool(SAMPLE_ROWS, SAMPLE_DUP_ROWS);
    const result = await runRepair(pool as never, { apply: false });

    expect(result.dryRun).toBe(true);
    expect(result.mismatched).toHaveLength(2);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.facts).toHaveLength(2);
    expect(result.updatedCount).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0]![0]).toBe(LIST_MISMATCHED_SQL);
    expect(pool.query.mock.calls[1]![0]).toBe(LIST_DUPLICATE_KEYS_SQL);
  });

  it('apply updates every mismatched id without touching last_confirmed_at', async () => {
    const pool = makePool(SAMPLE_ROWS, [], 2);
    const result = await runRepair(pool as never, { apply: true });

    expect(result.dryRun).toBe(false);
    expect(result.updatedCount).toBe(2);
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls[2]![0]).toBe(APPLY_BY_IDS_SQL);
    expect(APPLY_BY_IDS_SQL).not.toMatch(/last_confirmed_at/);
    expect(APPLY_BY_IDS_SQL).toMatch(/embedding = NULL/);
    expect(pool.query.mock.calls[2]![1]).toEqual([
      [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    ]);
  });

  it('apply with zero mismatches skips the UPDATE', async () => {
    const pool = makePool([]);
    const result = await runRepair(pool as never, { apply: true });

    expect(result.updatedCount).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('duplicate query dedupes then json_aggs by recency across anchor labels', () => {
    // Cross-anchor twins from the create race must still appear (GROUP BY label).
    expect(LIST_DUPLICATE_KEYS_SQL).toMatch(/SELECT DISTINCT/);
    expect(LIST_DUPLICATE_KEYS_SQL).toMatch(/json_agg/);
    expect(LIST_DUPLICATE_KEYS_SQL).toMatch(/ORDER BY last_confirmed_at DESC/);
    expect(LIST_DUPLICATE_KEYS_SQL).toMatch(/GROUP BY anchor_label, key/);
    expect(LIST_DUPLICATE_KEYS_SQL).not.toMatch(/GROUP BY a\.id/);
  });
});

describe('formatRepairReport', () => {
  it('names dry-run and lists each label → key pair', () => {
    const report = formatRepairReport({
      dryRun: true,
      mismatched: parseMismatchRows(SAMPLE_ROWS),
      duplicates: parseDuplicateRows(SAMPLE_DUP_ROWS),
      updatedCount: 0,
    });
    expect(report).toContain('DRY-RUN');
    expect(report).toContain('mismatched facts: 2');
    expect(report).toContain('duplicate (anchor, key) groups: 1');
    expect(report).toContain('processed_event_ids_1 → processed_event_ids_3');
    expect(report).toContain('--apply');
    expect(report).toContain('[current]');
    expect(report).toContain('value=["e3"]');
    expect(report).toContain('value=["e1","e2"]');
    expect(report).toContain('33333333-3333-3333-3333-333333333333');
  });

  it('reports a clean database as zero work', () => {
    const report = formatRepairReport({
      dryRun: true,
      mismatched: [],
      duplicates: [],
      updatedCount: 0,
    });
    expect(report).toContain('mismatched facts: 0');
    expect(report).toMatch(/no label/i);
  });
});
