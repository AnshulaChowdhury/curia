// Adding transactions: upload a bank file, or connect a bank. Shown on the budget overview.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  bankClient, validateAccount, accountLabel, statusText, BudgetApiError,
  type BanksState, type BankLink, type ImportResult,
} from './budget-banks.js';

export const CONNECT_PATH = '/budget/connect-bank';

function when(iso: string | null): string {
  if (!iso) return 'Never synced';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Never synced' : `Synced ${d.toLocaleString()}`;
}

export function ImportFilePanel({ onDone }: { onDone?: () => void }) {
  const [account, setAccount] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setResult(null);
    const problem = validateAccount(account) ?? (file ? null : 'Choose a bank file (.qbo, .ofx or .csv).');
    setError(problem);
    if (problem || !file) return;
    setBusy(true);
    try {
      setResult(await bankClient.importFile(file, account));
      setFile(null);
      if (input.current) input.current.value = '';
      onDone?.();
    } catch (err) {
      setError(err instanceof BudgetApiError && err.locked ? 'Budget data is private to the owner.' : err instanceof Error ? err.message : 'Import failed.');
    } finally { setBusy(false); }
  }

  return (
    <form className="bud-section" onSubmit={e => void submit(e)} noValidate aria-labelledby="bud-upload-h">
      <h3 className="bud-subtitle" id="bud-upload-h">Upload a bank file</h3>
      <p className="bud-hint">QBO, OFX, or a CSV from RBC, Tangerine or CIBC. Repeats are skipped.</p>
      <label className="bud-field">
        <span>Account name</span>
        <input className="bud-input" value={account} onChange={e => setAccount(e.target.value)} maxLength={80} placeholder="e.g. Chequing" aria-invalid={!!error && !account.trim()} />
      </label>
      <label className="bud-file">
        <input ref={input} className="bud-sr" type="file" accept=".qbo,.ofx,.csv" aria-label="Bank file" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        <span className="btn btn-secondary btn-sm" aria-hidden="true">Choose file</span>
        <span className="bud-file-name">{file ? file.name : 'No file chosen'}</span>
      </label>
      {error && <p className="bud-error" role="alert">{error}</p>}
      {result && (
        <p role="status" className="bud-ok">
          Imported {result.added} new, {result.duplicates} already there, {result.skipped} skipped. Each shows under its own month.
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-sm bud-submit" disabled={busy}>{busy ? 'Importing…' : 'Import file'}</button>
    </form>
  );
}

export function BankLinkRow({ link, busy, onSync, onDisconnect }: {
  link: BankLink; busy: boolean; onSync: () => void; onDisconnect: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="bud-bank">
      <div>
        <strong>{link.institution || 'Bank'}</strong>{' '}
        <span className={`bud-chip bud-chip-${link.status}`}>{statusText(link.status)}</span>
        <div className="bud-hint">{link.accounts.map(accountLabel).join(', ') || 'No accounts yet'} · {when(link.lastSyncedAt)}</div>
        {link.lastError && link.status !== 'active' && <div className="bud-error">{link.lastError}</div>}
      </div>
      <div className="bud-bank-actions">
        {link.status === 'needs_login' && <a className="btn btn-primary btn-sm" href={CONNECT_PATH}>Reconnect</a>}
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onSync}>Sync now</button>
        {confirming ? (
          <span role="group" aria-label={`Disconnect ${link.institution}?`}>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={onDisconnect}>Yes, disconnect</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>
        )}
      </div>
    </li>
  );
}

export function BanksPanel({ state, busy, message, onSyncAll, onSync, onDisconnect }: {
  state: BanksState | null; busy: boolean; message: string | null;
  onSyncAll: () => void; onSync: (id: string) => void; onDisconnect: (id: string) => void;
}) {
  return (
    <section className="bud-section" aria-labelledby="bud-banks-h">
      <h3 className="bud-subtitle" id="bud-banks-h">Connected banks</h3>
      {!state && <p className="bud-hint" role="status">Loading…</p>}
      {state && !state.configured && <p className="bud-hint" role="status">Plaid not set up. File import still works.</p>}
      {message && <p role="status" className="bud-ok">{message}</p>}
      {state?.configured && (
        <>
          <div className="bud-row">
            {/* A plain link on purpose: the connect page has its own CSP, which only applies to a full page load. */}
            <a className="btn btn-primary btn-sm" href={CONNECT_PATH}>Connect a bank</a>
            {state.links.length > 0 && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onSyncAll}>Sync all</button>}
          </div>
          {state.links.length === 0
            ? <p className="bud-hint">No banks connected yet.</p>
            : <ul className="bud-banks">{state.links.map(l => (
                <BankLinkRow key={l.id} link={l} busy={busy} onSync={() => onSync(l.id)} onDisconnect={() => onDisconnect(l.id)} />
              ))}</ul>}
        </>
      )}
    </section>
  );
}

export function AddTransactions({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<BanksState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setState(await bankClient.banks()); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Could not load banks.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function run(fn: () => Promise<string | null>) {
    setBusy(true); setMessage(null);
    try { setMessage(await fn()); await refresh(); onChanged(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  return (
    <section className="dash-card bud-add" aria-labelledby="bud-add-h">
      <h2 className="dash-card-title" id="bud-add-h">Add transactions</h2>
      <ImportFilePanel onDone={onChanged} />
      <BanksPanel
        state={state} busy={busy} message={message}
        onSyncAll={() => void run(async () => { await bankClient.syncAll(); return 'Sync finished.'; })}
        onSync={id => void run(async () => `Added ${await bankClient.syncOne(id)} new transactions.`)}
        onDisconnect={id => void run(async () => { await bankClient.disconnect(id); return 'Bank disconnected.'; })}
      />
    </section>
  );
}
