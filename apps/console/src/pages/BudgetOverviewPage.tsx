import { useCallback, useEffect, useRef, useState } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { BudgetBar, StatusMark } from '../components/MoneyCard.js';
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
        <span className="dash-card-quiet">No budget set</span>
      ) : (
        <>
          <BudgetBar spentCents={c.spentCents} budgetCents={c.budgetedCents} label={c.name} />
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
    <table className="records-table">
      <thead>
        <tr><th scope="col">Date</th><th scope="col">Payee</th><th scope="col" style={{ textAlign: 'right' }}>Amount</th><th scope="col">Category</th></tr>
      </thead>
      <tbody>
        {txns.slice(0, REVIEW_SHOWN).map(t => (
          <tr key={t.id}>
            <td>{t.date}</td>
            <td>{t.payee || t.description}<span className="dash-card-quiet"> · {t.account}</span></td>
            <td style={{ textAlign: 'right' }}>{formatCents(t.amountCents)}</td>
            <td className="bud-row-actions">
              <select
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
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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

  const data = load?.state === 'ok' ? load.data : null;
  const needs = data ? needsYouLines(data.summary) : [];

  return (
    <BudgetShell active="/budget">
      <div className="bud-month" role="group" aria-label="Month">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonth(m => shiftMonth(m, -1))}>
          <span aria-hidden="true">‹</span> Previous
        </button>
        <label className="bud-month-label">
          <span className="bud-sr">Month</span>
          <input
            type="month"
            value={month}
            onChange={e => { if (isMonth(e.target.value)) setMonth(e.target.value); }}
          />
        </label>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonth(m => shiftMonth(m, 1))}>
          Next <span aria-hidden="true">›</span>
        </button>
      </div>

      <BudgetGate load={load} />

      {data && (
        <>
          <section className="dash-card" aria-labelledby="bud-total-h">
            <h2 id="bud-total-h" className="dash-card-title">{formatMonth(month)}</h2>
            <div className="bud-total">
              <span className="bud-total-num">{formatCents(data.summary.totals.spentCents)}</span>
              <span className="dash-card-quiet"> spent of {formatCents(data.summary.totals.budgetedCents)} budgeted</span>
            </div>
            <BudgetBar spentCents={data.summary.totals.spentCents} budgetCents={data.summary.totals.budgetedCents} label="All categories" />
            {data.summary.totals.uncategorisedSpentCents > 0 && (
              <p className="dash-card-quiet">Includes {formatCents(data.summary.totals.uncategorisedSpentCents)} without a category.</p>
            )}
          </section>

          <section className="dash-card" aria-labelledby="bud-needs-h">
            <div className="dash-card-head">
              <h2 id="bud-needs-h" className="dash-card-title">Needs you</h2>
              <span className="dash-count">{needs.length}</span>
            </div>
            {needs.length === 0 ? (
              <p className="dash-card-quiet">Nothing needs you this month.</p>
            ) : (
              <ul className="bud-list">
                {needs.map(line => <li key={line}>{line}</li>)}
              </ul>
            )}
            {message && <p className="bud-error" role="alert">{message}</p>}
            {data.review.length > 0 && (
              data.categories.length === 0
                ? <p className="dash-card-quiet">Add a category on the Budgets tab, then assign these here.</p>
                : <ReviewList txns={data.review} categories={data.categories} busy={busy} onCategorise={(id, c) => void categorise(id, c)} />
            )}
          </section>

          <section className="dash-card" aria-labelledby="bud-cats-h">
            <h2 id="bud-cats-h" className="dash-card-title">Categories</h2>
            {data.summary.categories.length === 0 ? (
              <p className="dash-card-quiet">No budgets yet. Add one on the Budgets tab.</p>
            ) : (
              <ul className="bud-list">
                {data.summary.categories.map(c => <CategoryLine key={c.categoryId} c={c} />)}
              </ul>
            )}
          </section>
        </>
      )}
    </BudgetShell>
  );
}
