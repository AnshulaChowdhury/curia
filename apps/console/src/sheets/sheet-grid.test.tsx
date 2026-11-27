// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const createWorkbook = vi.fn();
vi.mock('@univerjs/presets', () => ({
  LocaleType: { EN_US: 'enUS' },
  mergeLocales: (locale: unknown) => locale,
  createUniver: () => ({ univer: { dispose: () => {} }, univerAPI: { createWorkbook, getActiveWorkbook: () => null } }),
}));
vi.mock('@univerjs/preset-sheets-core', () => ({ UniverSheetsCorePreset: () => ({}) }));
vi.mock('@univerjs/preset-sheets-core/locales/en-US', () => ({ default: {} }));
vi.mock('@univerjs/preset-sheets-core/lib/index.css', () => ({}));

const { default: SheetGrid } = await import('./SheetGrid.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SheetGrid', () => {
  afterEach(() => createWorkbook.mockClear());

  it('tells the grid the workbook is in English, or it writes month names in Chinese', async () => {
    const root = createRoot(document.createElement('div'));
    const sheet = { id: 's', name: 'Budget', version: 1, updatedAt: '', expiresAt: '', workbook: { id: 'w', sheetOrder: [], sheets: {} } };
    await act(async () => root.render(<SheetGrid sheet={sheet} onState={() => {}} />));
    expect(createWorkbook).toHaveBeenCalledWith({ ...sheet.workbook, locale: 'enUS' });
    await act(async () => root.unmount());
  });
});
