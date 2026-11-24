import { useEffect, useMemo, useState } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { BudgetBar, StatusMark } from '../components/MoneyCard.js';
import { budgetSource, type BudgetLoad } from './budget-data.js';
import { FIXTURE_MONTH } from './budget-fixtures.js';
import {
  buildRows, totalsOf, needsYou, formatCents, formatMonth, shiftMonth, isMonth, statusFor,
} from './budget-utils.js';

export default function BudgetOverviewPage() {
  const [load, setLoad] = useState<BudgetLoad | null>(null);
  const [month, setMonth] = useState(FIXTURE_MONTH);

  useEffect(() => {
    let live = true;
    budgetSource.load().then(r => { if (live) setLoad(r); }).catch(e => {
      console.error('budget load failed', e);
      if (live) setLoad({ state: 'error', message: 'Could not load the budget.' });
    });
    return () => { live = false; };
  }, []);

  const model = useMemo(() => {
    if (!load || load.state !== 'ok') return null;
    const rows = buildRows(load.categories, load.txns, month);
    return { rows, totals: totalsOf(rows), needs: needsYou(rows, load.txns, month) };
  }, [load, month]);

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

      {model && (
        <>
          <section className="dash-card" aria-labelledby="bud-total-h">
            <h2 id="bud-total-h" className="dash-card-title">{formatMonth(month)}</h2>
            <div className="bud-total">
              <span className="bud-total-num">{formatCents(model.totals.spentCents)}</span>
              <span className="dash-card-quiet"> spent of {formatCents(model.totals.budgetCents)} budgeted</span>
            </div>
            <BudgetBar spentCents={model.totals.spentCents} budgetCents={model.totals.budgetCents} label="All categories" />
            <StatusMark status={statusFor(model.totals.spentCents, model.totals.budgetCents)} />
          </section>

          <section className="dash-card" aria-labelledby="bud-needs-h">
            <div className="dash-card-head">
              <h2 id="bud-needs-h" className="dash-card-title">Needs you</h2>
              <span className="dash-count">{model.needs.length}</span>
            </div>
            {model.needs.length === 0 ? (
              <p className="dash-card-quiet">Nothing needs you this month.</p>
            ) : (
              <ul className="bud-list">
                {model.needs.map(n => <li key={n.id}>{n.label}</li>)}
              </ul>
            )}
          </section>

          <section className="dash-card" aria-labelledby="bud-cats-h">
            <h2 id="bud-cats-h" className="dash-card-title">Categories</h2>
            {model.rows.length === 0 ? (
              <p className="dash-card-quiet">No budgets yet. Add one on the Budgets tab.</p>
            ) : (
              <ul className="bud-list">
                {model.rows.map(r => (
                  <li key={r.id} className="bud-cat">
                    <div className="bud-mini-row">
                      <span className="bud-name">{r.name}</span>
                      <span className="bud-num">{formatCents(r.spentCents)} of {formatCents(r.budgetCents)}</span>
                    </div>
                    <BudgetBar spentCents={r.spentCents} budgetCents={r.budgetCents} label={r.name} />
                    <div className="bud-mini-row">
                      <StatusMark status={r.status} />
                      <span className="bud-num">
                        {r.remainingCents >= 0
                          ? `${formatCents(r.remainingCents)} left`
                          : `${formatCents(-r.remainingCents)} over`}
                        {r.rolloverInCents > 0 ? ` (includes ${formatCents(r.rolloverInCents)} carried over)` : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </BudgetShell>
  );
}
