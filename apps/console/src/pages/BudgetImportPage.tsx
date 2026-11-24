import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BudgetShell } from './BudgetShell.js';
import {
  bankClient, runPlaidLink, validateAccount, accountLabel, statusText, BudgetApiError,
  type BanksState, type BankLink, type ImportResult,
} from './budget-banks.js';

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
    <form className="dash-card bud-form" onSubmit={e => void submit(e)} noValidate>
      <h3 className="dash-card-title">Import a bank file</h3>
      <p className="dash-card-quiet">QBO, OFX, or a CSV from RBC, Tangerine or CIBC. Repeats are skipped.</p>
      <label className="bud-field">Account name
        <input value={account} onChange={e => setAccount(e.target.value)} maxLength={80} placeholder="e.g. Chequing" aria-invalid={!!error && !account.trim()} />
      </label>
      <label className="bud-field">File
        <input ref={input} type="file" accept=".qbo,.ofx,.csv" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </label>
      {error && <p className="bud-error" role="alert">{error}</p>}
      {result && (
        <p role="status" className="bud-ok">
          Imported {result.added} new, {result.duplicates} already there, {result.skipped} skipped.
        </p>
      )}
      <button type="submit" className="bud-btn" disabled={busy}>{busy ? 'Importing…' : 'Import file'}</button>
    </form>
  );
}

export function BankLinkRow({ link, busy, onSync, onReconnect, onDisconnect }: {
  link: BankLink; busy: boolean; onSync: () => void; onReconnect: () => void; onDisconnect: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="bud-bank">
      <div>
        <strong>{link.institution || 'Bank'}</strong>{' '}
        <span className={`bud-chip bud-chip-${link.status}`}>{statusText(link.status)}</span>
        <div className="dash-card-quiet">{link.accounts.map(accountLabel).join(', ') || 'No accounts yet'} · {when(link.lastSyncedAt)}</div>
        {link.lastError && link.status !== 'active' && <div className="bud-error">{link.lastError}</div>}
      </div>
      <div className="bud-bank-actions">
        {link.status === 'needs_login' && <button type="button" className="bud-btn" disabled={busy} onClick={onReconnect}>Reconnect</button>}
        <button type="button" className="bud-btn" disabled={busy} onClick={onSync}>Sync now</button>
        {confirming ? (
          <span role="group" aria-label={`Disconnect ${link.institution}?`}>
            <button type="button" className="bud-btn bud-danger" disabled={busy} onClick={onDisconnect}>Yes, disconnect</button>
            <button type="button" className="bud-btn" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="bud-btn" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>
        )}
      </div>
    </li>
  );
}

export function BanksPanel({ state, busy, message, onConnect, onSyncAll, onSync, onDisconnect }: {
  state: BanksState | null; busy: boolean; message: string | null;
  onConnect: () => void; onSyncAll: () => void; onSync: (id: string) => void; onDisconnect: (id: string) => void;
}) {
  return (
    <section className="dash-card" aria-labelledby="bud-banks-h">
      <h3 className="dash-card-title" id="bud-banks-h">Bank connections</h3>
      {!state && <p className="dash-card-quiet" role="status">Loading…</p>}
      {state && !state.configured && <p className="dash-card-quiet" role="status">Plaid not set up. File import still works.</p>}
      {message && <p role="status" className="bud-ok">{message}</p>}
      {state?.configured && (
        <>
          <div className="bud-row">
            <button type="button" className="bud-btn" disabled={busy} onClick={onConnect}>Connect a bank</button>
            {state.links.length > 0 && <button type="button" className="bud-btn" disabled={busy} onClick={onSyncAll}>Sync all</button>}
          </div>
          {state.links.length === 0
            ? <p className="dash-card-quiet">No banks connected yet.</p>
            : <ul className="bud-banks">{state.links.map(l => (
                <BankLinkRow key={l.id} link={l} busy={busy} onSync={() => onSync(l.id)} onReconnect={onConnect} onDisconnect={() => onDisconnect(l.id)} />
              ))}</ul>}
        </>
      )}
    </section>
  );
}

export default function BudgetImportPage() {
  const [state, setState] = useState<BanksState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const refresh = useCallback(async () => {
    try { setState(await bankClient.banks()); }
    catch (e) {
      if (e instanceof BudgetApiError && e.locked) setLocked(true);
      else setMessage(e instanceof Error ? e.message : 'Could not load banks.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function run(fn: () => Promise<string | null>) {
    setBusy(true); setMessage(null);
    try { setMessage(await fn()); await refresh(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  return (
    <BudgetShell active="/budget/import" live>
      {locked ? (
        <div className="dash-card" role="alert"><h3 className="dash-card-title">Locked</h3>
          <p className="dash-card-quiet">Budget data is private to the owner. Sign in as the owner to see it.</p></div>
      ) : (
        <>
          <ImportFilePanel />
          <BanksPanel
            state={state} busy={busy} message={message}
            onConnect={() => void run(async () => ((await runPlaidLink()) ? 'Bank connected.' : null))}
            onSyncAll={() => void run(async () => { await bankClient.syncAll(); return 'Sync finished.'; })}
            onSync={id => void run(async () => `Added ${await bankClient.syncOne(id)} new transactions.`)}
            onDisconnect={id => void run(async () => { await bankClient.disconnect(id); return 'Bank disconnected.'; })}
          />
        </>
      )}
    </BudgetShell>
  );
}
