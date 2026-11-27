// The spreadsheet page: add a file, pick a sheet, edit it. It stands alone (no sidebar) so it can later sit in a frame
// beside the chat. The server gives only this exact path the policy the grid needs, and a policy is fixed when the page
// loads: arriving here by in-app navigation reloads the page, and links away from it are full page loads.

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTheme } from '../hooks/useTheme.js';
import { convertFile, fileProblem } from '../sheets/convert-client.js';
import { sheetClient, SheetError, type Sheet, type SheetInfo } from '../sheets/sheet-client.js';
import type { SaveState } from '../sheets/autosave.js';

export const SHEET_PATH = '/budget/sheet-frame';
const SheetGrid = lazy(() => import('../sheets/SheetGrid.js'));

/** Whether this document was loaded from the sheet page itself, and so carries its policy. */
export function loadedAsSheetPage(entry: string | undefined): boolean {
  if (!entry) return true; // nothing to tell by: do not reload in a loop
  return new URL(entry, 'http://local').pathname.replace(/\/$/, '') === SHEET_PATH;
}

const SAVE_TEXT: Record<SaveState, string> = { saved: 'Saved', saving: 'Saving…', conflict: 'Not saving', failed: 'Not saved yet; trying again' };
const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const message = (err: unknown): string => (err instanceof SheetError && err.locked ? 'Budget data is private to the owner. Sign in as the owner.' : err instanceof Error ? err.message : 'Something went wrong.');

export function SheetList({ sheets, onDelete }: { sheets: SheetInfo[]; onDelete: (s: SheetInfo) => void }) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (sheets.length === 0) return <p className="bud-hint">No sheets yet.</p>;
  return (
    <ul className="bud-list">
      {sheets.map(s => (
        <li key={s.id} className="sheet-item">
          <a className="bud-name" href={`${SHEET_PATH}?id=${s.id}`}>{s.name}</a>
          <span className="bud-hint">Changed {day(s.updatedAt)} · kept until {day(s.expiresAt)}</span>
          {confirmId === s.id ? (
            <span className="bud-row">
              <button type="button" className="btn btn-danger btn-sm" onClick={() => { setConfirmId(null); onDelete(s); }}>Delete</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmId(null)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" aria-label={`Delete ${s.name}`} onClick={() => setConfirmId(s.id)}>Delete</button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Library() {
  const [sheets, setSheets] = useState<SheetInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSheets(await sheetClient.list()); } catch (err) { setError(message(err)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function add(file: File) {
    const problem = fileProblem(file);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const made = await sheetClient.create(file.name.replace(/\.(xlsx|csv)$/i, ''), await convertFile(file));
      window.location.assign(`${SHEET_PATH}?id=${made.id}`);
    } catch (err) {
      console.error('sheet import failed', err);
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-library">
      <section className="dash-card" aria-labelledby="sheet-add-h">
        <h2 id="sheet-add-h" className="dash-card-title">Open a spreadsheet</h2>
        <p className="bud-hint">An .xlsx or .csv file up to 2 MB. Curia keeps the cells, formulas and basic formatting, not the file. Charts and pictures are left out. Check the figures against your original.</p>
        <label className="bud-file">
          <input className="bud-sr" type="file" accept=".xlsx,.csv" disabled={busy} aria-label="Spreadsheet file"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void add(f); }} />
          <span className="btn btn-primary btn-sm" aria-hidden="true">{busy ? 'Reading…' : 'Choose file'}</span>
        </label>
        {error && <p className="bud-error" role="alert">{error}</p>}
      </section>
      <section className="dash-card" aria-labelledby="sheet-list-h">
        <h2 id="sheet-list-h" className="dash-card-title">Your sheets</h2>
        {sheets === null ? <p className="bud-hint" role="status">Loading…</p> : (
          <SheetList sheets={sheets} onDelete={s => void sheetClient.remove(s.id).then(refresh, err => setError(message(err)))} />
        )}
      </section>
    </div>
  );
}

function Editor({ id }: { id: string }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<{ state: SaveState; message?: string }>({ state: 'saved' });
  useEffect(() => { sheetClient.get(id).then(setSheet, err => setError(message(err))); }, [id]);

  if (error) return <div className="sheet-library"><div className="dash-card" role="alert"><p className="bud-hint">{error}</p></div></div>;
  if (!sheet) return <p className="bud-hint sheet-wait" role="status">Loading…</p>;
  return (
    <>
      <div className="sheet-status" role="status">
        <strong>{sheet.name}</strong>
        <span className={save.state === 'saved' || save.state === 'saving' ? 'bud-hint' : 'bud-error'}>{SAVE_TEXT[save.state]}{save.message ? `: ${save.message}` : ''}</span>
        {save.state === 'conflict' && <button type="button" className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>Reload</button>}
      </div>
      <Suspense fallback={<p className="bud-hint sheet-wait" role="status">Loading the grid…</p>}>
        <SheetGrid sheet={sheet} onState={(state, text) => setSave({ state, message: text })} />
      </Suspense>
    </>
  );
}

export default function SheetPage() {
  useTheme();
  const id = new URLSearchParams(window.location.search).get('id');
  const ready = loadedAsSheetPage(performance.getEntriesByType('navigation')[0]?.name);
  useEffect(() => { if (!ready) window.location.replace(window.location.href); }, [ready]);
  // The console's form styles stand aside on this page (app.css), so the grid's controls look as the library draws them.
  useEffect(() => {
    document.documentElement.classList.add('sheet-document');
    return () => document.documentElement.classList.remove('sheet-document');
  }, []);
  if (!ready) return null;
  const framed = window.self !== window.top;
  return (
    <main className="sheet-page bud-body-sheet">
      {!framed && (
        <nav className="sheet-nav" aria-label="Spreadsheets">
          <a href="/budget">← Household budget</a>
          {id && <a href={SHEET_PATH}>All sheets</a>}
        </nav>
      )}
      {id ? <Editor id={id} /> : <Library />}
    </main>
  );
}
