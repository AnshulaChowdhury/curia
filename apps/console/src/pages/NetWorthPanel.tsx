// What the owner owns and owes: totals, each side's accounts, and hand-kept entries. Shown on the budget overview.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { budgetClient } from './budget-data.js';
import {
  ASSET_LABELS, DEBT_LABELS, counted, groupAccounts, formatCents, centsToDollarInput, parseDollarsToCents,
  type AccountType, type BudgetAccount, type NetWorth,
} from './budget-utils.js';

interface Draft { id: string | null; name: string; type: AccountType; amount: string }
const EMPTY: Draft = { id: null, name: '', type: 'cash', amount: '' };

const day = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/** One side of the sheet. Account and bank names come from the bank and are rendered as text only. */
export function SideCard({ title, side, data, onEdit, onDelete }: {
  title: string;
  side: 'asset' | 'debt';
  data: NetWorth;
  onEdit: (a: BudgetAccount) => void;
  onDelete: (a: BudgetAccount) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const groups = groupAccounts(data.accounts, side);
  const total = side === 'asset' ? data.totals.assetsCents : data.totals.debtsCents;
  return (
    <section className="dash-card" aria-label={title}>
      <div className="dash-card-head">
        <h2 className="dash-card-title">{title}</h2>
        <span className="bud-side-total">{formatCents(total)}</span>
      </div>
      {groups.length === 0 && <p className="bud-hint">Nothing here yet.</p>}
      {groups.map(g => (
        <div key={g.type} className="bud-group">
          <div className="bud-mini-row">
            <h3 className="bud-subtitle">{g.label}</h3>
            <span className="bud-num">{formatCents(g.totalCents)}</span>
          </div>
          {total > 0 && (
            <div className={`bud-bar bud-bar-${side === 'debt' ? 'over' : 'under'}`} aria-hidden="true">
              <div className="bud-bar-fill" style={{ width: `${Math.min(Math.max((g.totalCents / total) * 100, 0), 100)}%` }} />
            </div>
          )}
          <ul className="bud-list">
            {g.accounts.map(a => (
              <li key={a.id} className="bud-account">
                <div className="bud-account-name">
                  <span className="bud-name">{a.name}{a.mask ? ` ••${a.mask}` : ''}</span>
                  <span className="bud-hint">
                    {a.source === 'bank' ? a.institution || 'Bank' : 'Entered by you'} · {day(a.asOf)}
                    {!counted(a) ? ' · not in totals' : ''}
                  </span>
                  {a.source === 'manual' && (
                    confirmId === a.id ? (
                      <span className="bud-row">
                        <span className="bud-hint">Delete {a.name}?</span>
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => { setConfirmId(null); onDelete(a); }}>Delete</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmId(null)}>Keep</button>
                      </span>
                    ) : (
                      <span className="bud-row">
                        <button type="button" className="bud-link" aria-label={`Edit ${a.name}`} onClick={() => onEdit(a)}>Edit</button>
                        <button type="button" className="bud-link" aria-label={`Delete ${a.name}`} onClick={() => setConfirmId(a.id)}>Delete</button>
                      </span>
                    )
                  )}
                </div>
                <span className="bud-account-amount">
                  {a.balanceCents === null ? 'No balance' : `${formatCents(a.balanceCents)}${a.currency === 'CAD' ? '' : ` ${a.currency}`}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function NetWorthSummary({ totals }: { totals: NetWorth['totals'] }) {
  const largest = Math.max(totals.assetsCents, totals.debtsCents, 1);
  const width = (cents: number) => `${Math.min(Math.max((cents / largest) * 100, 0), 100)}%`;
  return (
    <section className="dash-card" aria-label="Net worth totals">
      <dl className="bud-stats">
        <div className={totals.netCents < 0 ? 'is-over' : undefined}><dt>Net worth</dt><dd>{formatCents(totals.netCents)}</dd></div>
        <div><dt>You own</dt><dd>{formatCents(totals.assetsCents)}</dd></div>
        <div><dt>You owe</dt><dd>{formatCents(totals.debtsCents)}</dd></div>
      </dl>
      {/* The two bars share one scale, so their lengths compare directly. The figures above say the same in words. */}
      <div className="bud-compare" aria-hidden="true">
        <div className="bud-bar bud-bar-under"><div className="bud-bar-fill" style={{ width: width(totals.assetsCents) }} /></div>
        <div className="bud-bar bud-bar-over"><div className="bud-bar-fill" style={{ width: width(totals.debtsCents) }} /></div>
      </div>
      {totals.leftOut > 0 && (
        <p className="bud-hint">{totals.leftOut} account{totals.leftOut === 1 ? ' is' : 's are'} not in these totals (another currency, or no balance).</p>
      )}
    </section>
  );
}

export function NetWorthSection({ data, onChanged }: { data: NetWorth; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft | null>(null); // null: the form is closed
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  // Opening the form, or switching it to another entry, moves to its first field.
  const open = draft === null ? null : draft.id ?? 'new';
  useEffect(() => { if (open !== null) nameInput.current?.focus(); }, [open]);

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await action();
      setMessage(done);
      await onChanged();
    } catch (err) {
      console.error('budget accounts action failed', err);
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
    setBusy(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const cents = parseDollarsToCents(draft.amount);
    if (!draft.name.trim()) return setError('Give it a name.');
    if (cents === null) return setError('Enter an amount like 2500 or 2500.00.');
    void run(async () => {
      await budgetClient.saveAccount({ id: draft.id, name: draft.name.trim(), type: draft.type, balanceCents: cents });
      setDraft(null);
    }, `Saved ${draft.name.trim()}.`);
  }

  const close = () => { setDraft(null); setError(null); };
  const edit = (a: BudgetAccount) => {
    setError(null);
    setDraft({ id: a.id, name: a.name, type: a.type, amount: centsToDollarInput(a.balanceCents ?? 0) });
  };
  const remove = (a: BudgetAccount) => void run(async () => {
    await budgetClient.deleteAccount(a.id);
    setDraft(d => (d?.id === a.id ? null : d));
  }, `Deleted ${a.name}.`);

  return (
    <section id="bud-networth" className="bud-networth" aria-labelledby="bud-networth-h">
      <div className="bud-section-head">
        <h2 id="bud-networth-h" className="bud-heading">Assets and liabilities</h2>
        <div className="bud-row">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => void run(() => budgetClient.refreshBanks(), 'Sync finished. Each balance shows the date it was read.')}>
            {busy ? 'Working…' : 'Refresh bank balances'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" aria-expanded={draft !== null}
            onClick={() => (draft ? close() : setDraft(EMPTY))}>
            Add an asset or liability
          </button>
        </div>
      </div>
      {message && <p className="bud-ok" role="status">{message}</p>}
      {error && !draft && <p className="bud-error" role="alert">{error}</p>}
      {draft && (
        <form className="dash-card" onSubmit={submit} noValidate aria-labelledby="bud-acct-h">
          <h3 id="bud-acct-h" className="dash-card-title">{draft.id ? 'Edit entry' : 'Add an asset or liability'}</h3>
          <p className="bud-hint">For anything a connected bank does not show, such as a home, a car, investments or a mortgage.</p>
          <div className="bud-form bud-form-4">
            <label className="bud-field">
              <span>Name</span>
              <input ref={nameInput} className="bud-input" type="text" maxLength={120} placeholder="e.g. Home"
                value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="bud-field">
              <span>Kind</span>
              <select className="bud-input" value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as AccountType })}>
                <optgroup label="Assets">
                  {Object.entries(ASSET_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </optgroup>
                <optgroup label="Liabilities">
                  {Object.entries(DEBT_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </optgroup>
              </select>
            </label>
            <label className="bud-field">
              <span>Value or amount owed (CAD)</span>
              <input className="bud-input" type="text" inputMode="decimal" placeholder="0.00"
                value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value })} />
            </label>
            <div className="bud-actions">
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{draft.id ? 'Save changes' : 'Add'}</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={close}>Cancel</button>
            </div>
          </div>
          {error && <p className="bud-error" role="alert">{error}</p>}
        </form>
      )}
      <NetWorthSummary totals={data.totals} />
      <div className="bud-pair">
        <SideCard title="Assets" side="asset" data={data} onEdit={edit} onDelete={remove} />
        <SideCard title="Liabilities" side="debt" data={data} onEdit={edit} onDelete={remove} />
      </div>
    </section>
  );
}
