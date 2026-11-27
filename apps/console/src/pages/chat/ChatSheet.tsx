// The chat's spreadsheet controls: the attach button, the bar above the message box, and the grid beside the chat.

import type { SheetInfo } from '../../sheets/sheet-client.js';
import { CHAT_PATH } from './useChatSheet.js';

const PAPERCLIP = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/**
 * Chooses a spreadsheet. On a page that was not loaded as the chat page it cannot open the file converter, so it is a
 * full page load of the chat instead.
 */
export function AttachButton({ ready, busy, onFile }: { ready: boolean; busy: boolean; onFile: (file: File) => void }) {
  if (!ready) {
    return (
      <a className="btn btn-secondary chat-attach" href={`${CHAT_PATH}?attach=1`} aria-label="Attach a spreadsheet" title="Attach a spreadsheet (reloads the chat once)">
        {PAPERCLIP}
      </a>
    );
  }
  return (
    <label className="btn btn-secondary chat-attach" title="Attach a spreadsheet (.xlsx or .csv)">
      <input className="bud-sr" type="file" accept=".xlsx,.csv" disabled={busy} aria-label="Attach a spreadsheet"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      {busy ? <span aria-hidden="true">…</span> : PAPERCLIP}
    </label>
  );
}

export function SheetBar({ sheet, ready, open, busy, error, hint, onToggle, onDetach }: {
  sheet: SheetInfo | null; ready: boolean; open: boolean; busy: boolean; error: string | null; hint: boolean;
  onToggle: () => void; onDetach: () => void;
}) {
  if (!sheet && !busy && !error && !hint) return null;
  return (
    <div className="chat-sheet-bar">
      {busy && <span role="status">Reading the spreadsheet…</span>}
      {!busy && !sheet && !error && hint && <span>Choose the paperclip to pick your spreadsheet.</span>}
      {sheet && (
        <>
          <span className="chat-sheet-name">Attached: <strong>{sheet.name}</strong></span>
          {ready
            ? <button type="button" className="bud-link" aria-expanded={open} onClick={onToggle}>{open ? 'Hide sheet' : 'Show sheet'}</button>
            : <a className="bud-link" href={CHAT_PATH}>Show sheet</a>}
          <button type="button" className="bud-link" onClick={onDetach}>Detach</button>
        </>
      )}
      {error && <span className="bud-error" role="alert">{error}</span>}
    </div>
  );
}

/** The grid, in its own page with its own policy. Hiding keeps it loaded, so nothing being typed is dropped. */
export function SheetSide({ sheet, hidden }: { sheet: SheetInfo; hidden: boolean }) {
  return (
    <aside className="chat-sheet" hidden={hidden} aria-label={`Spreadsheet ${sheet.name}`}>
      <iframe key={sheet.id} title={`Spreadsheet ${sheet.name}`} src={`/budget/sheet-frame?id=${encodeURIComponent(sheet.id)}`} />
    </aside>
  );
}
