// scripts/repair-config-store-labels.test.ts
//
// Unit tests for the config-store label repair (#2252). The script's job is to
// list (and optionally fix) facts where label ≠ properties.key after semantic
// dedup merged similar config keys. Overwritten values are not recoverable.

import { describe, it, expect, vi } from 'vitest';
import {
  runRepair,
  formatRepairReport,
  parseMismatchRows,
  LIST_MISMATCHED_SQL,
  APPLY_BY_IDS_SQL,
} from './repair-config-store-labels.js';

type MockPool = { query: ReturnType<typeof vi.fn> };

function makePool(listRows: unknown[], applyRowCount = 0): MockPool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql === LIST_MISMATCHED_SQL) {
        return Promise.resolve({ rows: listRows });
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
    anchor_label: 'config:travel_detection',
    label: 'processed_event_ids_1',
    key: 'processed_event_ids_3',
    value_preview: '["e1","e2"]',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    anchor_label: 'config:debrief',
    label: 'seen:04ncurue_20260921T213000Z',
    key: 'seen:04ncurue_20261019T213000Z',
    value_preview: '1',
  },
];

describe('parseMismatchRows', () => {
  it('maps SQL columns to the report shape', () => {
    expect(parseMismatchRows(SAMPLE_ROWS)).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        anchorLabel: 'config:travel_detection',
        label: 'processed_event_ids_1',
        key: 'processed_event_ids_3',
        valuePreview: '["e1","e2"]',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        anchorLabel: 'config:debrief',
        label: 'seen:04ncurue_20260921T213000Z',
        key: 'seen:04ncurue_20261019T213000Z',
        valuePreview: '1',
      },
    ]);
  });

  it('throws when a required column is missing', () => {
    expect(() => parseMismatchRows([{ id: 'x' }])).toThrow(/anchor_label/);
  });
});

describe('runRepair', () => {
  it('dry-run lists mismatches and writes nothing', async () => {
    const pool = makePool(SAMPLE_ROWS);
    const result = await runRepair(pool as never, { apply: false });

    expect(result.dryRun).toBe(true);
    expect(result.mismatched).toHaveLength(2);
    expect(result.updatedCount).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0]![0]).toBe(LIST_MISMATCHED_SQL);
  });

  it('apply updates every mismatched id', async () => {
    const pool = makePool(SAMPLE_ROWS, 2);
    const result = await runRepair(pool as never, { apply: true });

    expect(result.dryRun).toBe(false);
    expect(result.updatedCount).toBe(2);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1]![0]).toBe(APPLY_BY_IDS_SQL);
    expect(pool.query.mock.calls[1]![1]).toEqual([
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
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('formatRepairReport', () => {
  it('names dry-run and lists each label → key pair', () => {
    const report = formatRepairReport({
      dryRun: true,
      mismatched: parseMismatchRows(SAMPLE_ROWS),
      updatedCount: 0,
    });
    expect(report).toContain('DRY-RUN');
    expect(report).toContain('mismatched facts: 2');
    expect(report).toContain('processed_event_ids_1 → processed_event_ids_3');
    expect(report).toContain('--apply');
  });

  it('reports a clean database as zero work', () => {
    const report = formatRepairReport({ dryRun: true, mismatched: [], updatedCount: 0 });
    expect(report).toContain('mismatched facts: 0');
    expect(report).toMatch(/none/i);
  });
});
