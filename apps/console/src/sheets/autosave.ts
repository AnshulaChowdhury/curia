// Saving the grid as it is edited: look at the workbook every so often and save it when it differs from the last saved
// copy. A conflict (saved somewhere else) stops saving until the sheet is reloaded, so nothing is overwritten.

import { SheetError } from './sheet-client.js';

export type SaveState = 'saved' | 'saving' | 'conflict' | 'failed';

export interface AutosaveOptions {
  read: () => unknown;
  save: (version: number, workbook: unknown) => Promise<{ version: number }>;
  version: number;
  onState: (state: SaveState, message?: string) => void;
}

export function createAutosave({ read, save, version, onState }: AutosaveOptions) {
  let current = version;
  let last = JSON.stringify(read());
  let busy = false;
  let stopped = false;
  return {
    /** Saves if the workbook changed since the last save. Safe to call as often as wanted. */
    async tick(): Promise<void> {
      if (busy || stopped) return;
      const workbook = read();
      const text = JSON.stringify(workbook);
      if (text === last) return;
      busy = true;
      onState('saving');
      try {
        current = (await save(current, workbook)).version;
        last = text;
        onState('saved');
      } catch (err) {
        if (err instanceof SheetError && err.conflict) { stopped = true; onState('conflict', err.message); }
        else onState('failed', err instanceof Error ? err.message : 'Could not save.');
      } finally {
        busy = false;
      }
    },
    stop(): void { stopped = true; },
  };
}
