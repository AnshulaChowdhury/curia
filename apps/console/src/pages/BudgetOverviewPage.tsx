import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { BudgetBar, StatusMark } from '../components/MoneyCard.js';
import { AddTransactions } from './BudgetAccountsPanel.js';
import { budgetClient, type BudgetLoad, type MonthData } from './budget-data.js';
import {
  currentMonth, needsYouLines, formatCents, formatMonth, shiftMonth, isMonth,
  type BudgetCategory, type BudgetTxn, type CategorySummary,
} from './budget-utils.js';

/** How many transactions to list at once; more appear as these are categorised. */
const REVIEW_SHOWN = 50;

const leftOrOver = (remainingCents: number): string =>
  remainingCents >= 0 ? `${formatCents(remainingCents)} left` : `${formatCents(-remainingCents)} over`;

export function CategoryLine({ c }: { c: CategorySummary }) {
  return (
    <li className="bud-cat">
      <div className="bud-mini-row">
        <span className="bud-name">{c.name}</span>
        <span className="bud-num">
          {c.budgetedCents === null ? `${formatCents(c.spentCents)} spent` : `${formatCents(c.spentCents)} of ${formatCents(c.budgetedCents)}`}
        </span>
      </div>
      {c.state === 'no_budget' || c.budgetedCents === null ? (
        <span className="bud-hint">No budget set</span>
      ) : (
        <>
          <BudgetBar spentCents={c.spentCents} budgetCents={c.budgetedCents} label={c.name} status={c.state} />
          <div className="bud-mini-row">
            <StatusMark status={c.state} />
            <span className="bud-num">{leftOrOver(c.budgetedCents - c.spentCents)}</span>
          </div>
        </>
      )}
    </li>
  );
}

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
  load: BudgetLoad<MonthData> | null;
  month: string;
  busy: boolean;
  message: string | null;
  onMonth: (month: string) => void;
  onCategorise: (id: string, categoryId: string) => void;
  /** The "add transactions" panel. A slot, so this view stays free of data fetching. */
  accounts: ReactNode;
}) {
  const data = load?.state === 'ok' ? load.data : null;
  const needs = data ? needsYouLines(data.summary) : [];
  const totals = data?.summary.totals;
  const hasBudget = (totals?.budgetedCents ?? 0) > 0;
  const left = totals ? totals.budgetedCents - totals.spentCents : 0;

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

      {totals && (
        <section className="dash-card bud-hero" aria-label={`Totals for ${formatMonth(month)}`}>
          <dl className="bud-stats">
            <div><dt>Spent</dt><dd>{formatCents(totals.spentCents)}</dd></div>
            <div><dt>Budgeted</dt><dd>{hasBudget ? formatCents(totals.budgetedCents) : '—'}</dd></div>
            <div className={hasBudget && left < 0 ? 'is-over' : undefined}>
              <dt>{hasBudget && left < 0 ? 'Over' : 'Left'}</dt><dd>{hasBudget ? formatCents(Math.abs(left)) : '—'}</dd>
            </div>
          </dl>
          {hasBudget && (
            <BudgetBar spentCents={totals.spentCents} budgetCents={totals.budgetedCents} label="All categories" status={left < 0 ? 'over' : 'under'} />
          )}
          {totals.uncategorisedSpentCents > 0 && (
            <p className="bud-hint">Includes {formatCents(totals.uncategorisedSpentCents)} without a category.</p>
          )}
        </section>
      )}

      {data && (needs.length > 0 || data.review.length > 0) && (
        <section className="dash-card" aria-labelledby="bud-needs-h">
          <div className="dash-card-head">
            <h2 id="bud-needs-h" className="dash-card-title">Needs you</h2>
            <span className="dash-count">{needs.length}</span>
          </div>
          <ul className="bud-chips">
            {needs.map(line => <li key={line}>{line}</li>)}
          </ul>
          {message && <p className="bud-error" role="alert">{message}</p>}
          {data.review.length > 0 && (
            data.categories.length === 0
              ? <p className="bud-hint">Add a category on the Budgets tab, then assign these here.</p>
              : <div className="bud-table-wrap"><ReviewList txns={data.review} categories={data.categories} busy={busy} onCategorise={onCategorise} /></div>
          )}
        </section>
      )}

      {load?.state !== 'locked' && (
        <div className="bud-grid">
          <div>
            {data && (
              <section className="dash-card" aria-labelledby="bud-cats-h">
                <h2 id="bud-cats-h" className="dash-card-title">Categories</h2>
                {data.summary.categories.length === 0 ? (
                  <div className="bud-empty">
                    <p className="bud-hint">No budgets yet.</p>
                    <a className="btn btn-primary btn-sm" href="/budget/budgets">Add a budget</a>
                  </div>
                ) : (
                  <ul className="bud-list">
                    {data.summary.categories.map(c => <CategoryLine key={c.categoryId} c={c} />)}
                  </ul>
                )}
              </section>
            )}
          </div>
          {accounts}
        </div>
      )}
    </>
  );
}

export default function BudgetOverviewPage() {
  const [load, setLoad] = useState<BudgetLoad<MonthData> | null>(null);
  const [month, setMonth] = useState(() => currentMonth());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wanted = useRef(month);

  // Only the answer for the month on screen is applied, so a slow reply cannot show another month's numbers.
  const refresh = useCallback(async (m: string) => {
    const result = await budgetClient.loadMonth(m);
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
    <BudgetShell active="/budget">
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
