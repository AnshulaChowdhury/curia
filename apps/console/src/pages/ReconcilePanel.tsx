// Reconciliation: the month's transactions that still need a category, or a guess confirmed. Shown on the Budgets tab.
import { MonthPicker } from './MonthPicker.js';
import { displayName, formatCents, formatMonth, type BudgetCategory, type BudgetTxn } from './budget-utils.js';

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
        {txns.slice(0, REVIEW_SHOWN).map(t => {
          // A guess may still point at a category that has since been archived: show it, but it cannot be chosen again.
          const closed = categories.find(c => c.id === t.categoryId && c.archived);
          return (
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
                {closed && <option value={closed.id} disabled>{displayName(closed)}</option>}
                {categories.filter(c => !c.archived).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {t.source === 'agent_guess' && t.categoryId && !closed && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onCategorise(t.id, t.categoryId!)}>Confirm guess</button>
              )}
            </div></td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ReconcileSection({ month, data, busy, error, onMonth, onCategorise }: {
  month: string;
  /** Null while the chosen month is still loading. */
  data: { categories: BudgetCategory[]; review: BudgetTxn[] } | null;
  busy: boolean;
  error: string | null;
  onMonth: (month: string) => void;
  onCategorise: (id: string, categoryId: string) => void;
}) {
  return (
    <section className="dash-card" aria-labelledby="bud-needs-h">
      <div className="dash-card-head">
        <h2 id="bud-needs-h" className="dash-card-title">
          Needs a category{data && data.review.length > 0 && <> <span className="dash-count">{data.review.length}</span></>}
        </h2>
        <MonthPicker month={month} onMonth={onMonth} />
      </div>
      {error && <p className="bud-error" role="alert">{error}</p>}
      {!data ? <p className="bud-hint" role="status">Loading…</p>
        : data.review.length === 0 ? <p className="bud-hint">Nothing to categorise in {formatMonth(month)}.</p>
          : data.categories.every(c => c.archived) ? <p className="bud-hint">Add a budget below, then assign these here.</p>
            : <div className="bud-table-wrap bud-review-scroll"><ReviewList txns={data.review} categories={data.categories} busy={busy} onCategorise={onCategorise} /></div>}
    </section>
  );
}
