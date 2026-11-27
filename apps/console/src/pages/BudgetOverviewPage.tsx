import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { AddTransactions } from './BudgetAccountsPanel.js';
import { ActionItems, CategoryBar, SpendingPanel, StatusColumn, Tiles } from './BudgetDashboard.js';
import { budgetClient, type BudgetLoad, type DashboardData } from './budget-data.js';
import {
  currentMonth, today, formatCents, shiftMonth, isMonth,
  type BudgetCategory, type BudgetTxn,
} from './budget-utils.js';

/** How many transactions to list at once; more appear as these are categorised. */
const REVIEW_SHOWN = 50;

/** Transactions waiting for a category. Payee and description are bank text and are rendered as text only. */
export function ReviewList({ txns, categories, busy, onCategorise }: {
  txns: BudgetTxn[];
  categories: BudgetCategory[];
  busy: boolean;
  onCategorise: (id: string, categoryId: string) => void;
}) {
  return (
    <table className="bud-table">
      <thead>
        <tr><th scope="col">Date</th><th scope="col">Payee</th><th scope="col" className="bud-right">Amount</th><th scope="col">Category</th></tr>
      </thead>
      <tbody>
        {txns.slice(0, REVIEW_SHOWN).map(t => (
          <tr key={t.id}>
            <td>{t.date}</td>
            <td>{t.payee || t.description}<div className="bud-hint">{t.account}</div></td>
            <td className="bud-right">{formatCents(t.amountCents)}</td>
            <td><div className="bud-pick">
              <select
                className="bud-input"
                aria-label={`Category for ${t.payee || t.description} on ${t.date}`}
                value={t.categoryId ?? ''}
                disabled={busy}
                onChange={e => { if (e.target.value) onCategorise(t.id, e.target.value); }}
              >
                <option value="">Choose…</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {t.source === 'agent_guess' && t.categoryId && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onCategorise(t.id, t.categoryId!)}>Confirm guess</button>
              )}
            </div></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OverviewView({ load, month, busy, message, onMonth, onCategorise, accounts }: {
  load: BudgetLoad<DashboardData> | null;
  month: string;
  busy: boolean;
  message: string | null;
  onMonth: (month: string) => void;
  onCategorise: (id: string, categoryId: string) => void;
  /** The "add transactions" panel. A slot, so this view stays free of data fetching. */
  accounts: ReactNode;
}) {
  const data = load?.state === 'ok' ? load.data : null;

  return (
    <>
      <div className="bud-month" role="group" aria-label="Month">
        <button type="button" className="btn btn-secondary btn-sm" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}>‹</button>
        <label>
          <span className="bud-sr">Month</span>
          <input className="bud-input" type="month" value={month} onChange={e => { if (isMonth(e.target.value)) onMonth(e.target.value); }} />
        </label>
        <button type="button" className="btn btn-secondary btn-sm" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}>›</button>
      </div>

      <BudgetGate load={load} />

      {data && (
        <>
          <div className="bud-top">
            <Tiles data={data} />
            <div className="bud-top-main">
              <SpendingPanel data={data} />
              <CategoryBar data={data} />
            </div>
          </div>
          <div className="bud-columns">
            <ActionItems data={data} />
            <StatusColumn data={data} column="over" />
            <StatusColumn data={data} column="near" />
            <StatusColumn data={data} column="under" />
          </div>
        </>
      )}

      {data && data.review.length > 0 && (
        <section id="bud-review" className="dash-card" aria-labelledby="bud-needs-h">
          <div className="dash-card-head">
            <h2 id="bud-needs-h" className="dash-card-title">Needs a category</h2>
            <span className="dash-count">{data.review.length}</span>
          </div>
          {message && <p className="bud-error" role="alert">{message}</p>}
          {data.categories.length === 0
            ? <p className="bud-hint">Add a category on the Budgets tab, then assign these here.</p>
            : <div className="bud-table-wrap bud-review-scroll"><ReviewList txns={data.review} categories={data.categories} busy={busy} onCategorise={onCategorise} /></div>}
        </section>
      )}

      {load?.state !== 'locked' && <div id="bud-add">{accounts}</div>}
    </>
  );
}

export default function BudgetOverviewPage() {
  const [load, setLoad] = useState<BudgetLoad<DashboardData> | null>(null);
  const [month, setMonth] = useState(() => currentMonth());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wanted = useRef(month);

  // Only the answer for the month on screen is applied, so a slow reply cannot show another month's numbers.
  const refresh = useCallback(async (m: string) => {
    const result = await budgetClient.loadDashboard(m, today());
    if (wanted.current === m) setLoad(result);
  }, []);

  useEffect(() => {
    wanted.current = month;
    setLoad(null);
    setMessage(null);
    void refresh(month);
  }, [month, refresh]);

  async function categorise(id: string, categoryId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await budgetClient.categorise(id, categoryId);
      await refresh(wanted.current);
    } catch (err) {
      console.error('budget categorise failed', err);
      setMessage('Could not save that category.');
    }
    setBusy(false);
  }

  return (
    <BudgetShell active="/budget" wide>
      <OverviewView
        load={load}
        month={month}
        busy={busy}
        message={message}
        onMonth={setMonth}
        onCategorise={(id, c) => void categorise(id, c)}
        accounts={<AddTransactions onChanged={() => void refresh(wanted.current)} />}
      />
    </BudgetShell>
  );
}
