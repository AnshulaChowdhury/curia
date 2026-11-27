// Budgets month by month: a row per category, grouped into income, expenses and savings, a column per month. Each cell
// can be edited; leaving it empty goes back to the category's usual monthly amount.

import { Fragment } from 'react';
import { formatCents, formatMonth, KIND_LABEL, type BudgetPlan, type CategoryKind } from './budget-utils.js';
import { AmountInput } from './AmountInput.js';

const ORDER: CategoryKind[] = ['income', 'expense', 'savings'];

const total = (rows: BudgetPlan['categories'], index: number): number => rows.reduce((n, c) => n + (c.amounts[index]?.cents ?? 0), 0);

export function PlanGrid({ plan, onSet }: { plan: BudgetPlan; onSet: (categoryId: string, month: string, cents: number | null) => void }) {
  const groups = ORDER.map(kind => ({ kind, rows: plan.categories.filter(c => c.kind === kind) })).filter(g => g.rows.length > 0);
  const income = plan.categories.filter(c => c.kind === 'income');
  const out = plan.categories.filter(c => c.kind !== 'income');
  return (
    <section className="dash-card" aria-labelledby="bud-plan-h">
      <h2 id="bud-plan-h" className="dash-card-title">Budget by month</h2>
      {groups.length === 0 ? <p className="bud-hint">No categories yet. Add one below, or attach your budget in Chat and ask for categories.</p> : (
        <div className="bud-table-wrap"><table className="bud-table bud-plan">
          <thead>
            <tr><th scope="col">Category</th>{plan.months.map(m => <th key={m} scope="col" className="bud-right">{formatMonth(m)}</th>)}</tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.kind}>
                <tr className="bud-plan-group"><th scope="rowgroup" colSpan={plan.months.length + 1}>{KIND_LABEL[g.kind]}</th></tr>
                {g.rows.map(c => (
                  <tr key={c.categoryId}>
                    <th scope="row" className="bud-name">{c.name}</th>
                    {plan.months.map((m, i) => (
                      <td key={m} className="bud-right">
                        <AmountInput label={`${c.name}, ${formatMonth(m)}`} cents={c.amounts[i]?.cents ?? null} onSet={cents => onSet(c.categoryId, m, cents)} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="bud-plan-total">
                  <th scope="row">Total {KIND_LABEL[g.kind].toLowerCase()}</th>
                  {plan.months.map((m, i) => <td key={m} className="bud-right">{formatCents(total(g.rows, i))}</td>)}
                </tr>
              </Fragment>
            ))}
            {income.length > 0 && out.length > 0 && (
              <tr className="bud-plan-total">
                <th scope="row">Left over</th>
                {plan.months.map((m, i) => <td key={m} className="bud-right">{formatCents(total(income, i) - total(out, i))}</td>)}
              </tr>
            )}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
