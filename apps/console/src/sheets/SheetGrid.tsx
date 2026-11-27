// The Univer grid for one sheet, saving as it is edited. Loaded only on the sheet page: Univer is large.

import { useEffect, useRef } from 'react';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';
import { createAutosave, type SaveState } from './autosave.js';
import { sheetClient, type Sheet } from './sheet-client.js';

const SAVE_EVERY_MS = 2000;

export default function SheetGrid({ sheet, onState }: { sheet: Sheet; onState: (state: SaveState, message?: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const report = useRef(onState);
  report.current = onState;

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
    univerAPI.createWorkbook(sheet.workbook as Parameters<typeof univerAPI.createWorkbook>[0]);
    const autosave = createAutosave({
      read: () => univerAPI.getActiveWorkbook()?.save() ?? null,
      save: (version, workbook) => sheetClient.save(sheet.id, version, workbook),
      version: sheet.version,
      onState: (state, message) => report.current(state, message),
    });
    const timer = window.setInterval(() => void autosave.tick(), SAVE_EVERY_MS);
    // Leaving the page: one last try, so the final edit is not lost.
    const flush = () => void autosave.tick();
    window.addEventListener('pagehide', flush);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', flush);
      autosave.stop();
      // Disposed after this render pass: Univer unmounts its own React tree, which React refuses mid-render.
      window.setTimeout(() => { univer.dispose(); host.remove(); }, 0);
    };
  }, [sheet]);

  return <div ref={box} className="sheet-grid" />;
}
