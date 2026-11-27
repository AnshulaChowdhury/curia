// The Univer grid for one sheet, saving as it is edited. Loaded only on the sheet page: Univer is large.

import { useEffect, useRef } from 'react';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';
import { createAutosave, type SaveState } from './autosave.js';
import { sheetClient, type Sheet } from './sheet-client.js';
import { useIsDark } from '../hooks/useIsDark.js';

const SAVE_EVERY_MS = 2000;

export default function SheetGrid({ sheet, onState }: { sheet: Sheet; onState: (state: SaveState, message?: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const report = useRef(onState);
  report.current = onState;
  const dark = useIsDark();
  const grid = useRef<ReturnType<typeof createUniver>['univerAPI'] | null>(null);

  useEffect(() => {
    // Univer takes over the element it is given and cannot be re-mounted into it, so each load gets its own.
    const host = document.createElement('div');
    host.className = 'sheet-host';
    box.current!.appendChild(host);
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: mergeLocales(enUS) },
      presets: [UniverSheetsCorePreset({ container: host })],
    });
    // The library takes a workbook that names no language to be Chinese (month names came out as "11月"), and stored
    // workbooks name none.
    univerAPI.createWorkbook({ ...sheet.workbook, locale: LocaleType.EN_US } as Parameters<typeof univerAPI.createWorkbook>[0]);
    grid.current = univerAPI;
    const autosave = createAutosave({
      read: () => univerAPI.getActiveWorkbook()?.save() ?? null,
      save: (version, workbook) => sheetClient.save(sheet.id, version, workbook),
      version: sheet.version,
      onState: (state, message) => report.current(state, message),
    });
    const timer = window.setInterval(() => void autosave.tick(), SAVE_EVERY_MS);
    // Leaving the page, or (beside the chat) moving to the message box: save at once, so the assistant reads the
    // latest and the final edit is not lost.
    const flush = () => void autosave.tick();
    window.addEventListener('pagehide', flush);
    window.addEventListener('blur', flush);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('blur', flush);
      autosave.stop();
      grid.current = null;
      // Disposed after this render pass: Univer unmounts its own React tree, which React refuses mid-render.
      window.setTimeout(() => { univer.dispose(); host.remove(); }, 0);
    };
  }, [sheet]);

  // After the effect above, which makes the grid. Only the colours on screen change; the workbook is not touched.
  useEffect(() => { grid.current?.toggleDarkMode(dark); }, [sheet, dark]);

  return <div ref={box} className="sheet-grid" />;
}
