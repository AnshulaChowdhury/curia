// The whole budget month by month: a row per category, grouped into income, expenses and savings, a column per month,
// with net worth underneath if the budget holds. Category names and month headings stay put while it scrolls. Each
// amount saves as it is edited (empty goes back to the category's usual monthly amount), and the selected one can be
// copied to every later month.

import { Fragment, useEffect, useRef, useState } from 'react';
import { formatCents, formatMonth, KIND_LABEL, MAX_GRID_MONTHS, type BudgetPlan, type CategoryKind, type FullPlan } from './budget-utils.js';
import { AmountInput } from './AmountInput.js';
import { NetWorthNote, netWorthRows } from './chat/ProposalNetWorth.js';

const ORDER: CategoryKind[] = ['income', 'expense', 'savings'];

const total = (rows: BudgetPlan['categories'], index: number): number => rows.reduce((n, c) => n + (c.amounts[index]?.cents ?? 0), 0);

export interface Selected { categoryId: string; month: string }

/** What copying the selected amount forward would do: null when nothing is selected or the category has gone. */
export function fillTarget(plan: BudgetPlan, selected: Selected | null): { name: string; month: string; cents: number | null; later: string[] } | null {
  const category = plan.categories.find(c => c.categoryId === selected?.categoryId);
  const at = selected ? plan.months.indexOf(selected.month) : -1;
  if (!category || at < 0) return null;
  return { name: category.name, month: plan.months[at]!, cents: category.amounts[at]?.cents ?? null, later: plan.months.slice(at + 1) };
}

/** Copies the selected amount to every later month shown, after saying what it will replace. */
export function FillForward({ plan, selected, saving, onFill }: {
  plan: BudgetPlan; selected: Selected | null; saving: boolean;
  onFill: (categoryId: string, months: string[], cents: number) => void;
}) {
  // Which selection is being confirmed: choosing another amount withdraws the question.
  const [asked, setAsked] = useState<string | null>(null);
  const target = fillTarget(plan, selected);
  const key = selected ? `${selected.categoryId} ${selected.month}` : null;
  const hint = (text: string) => <p className="bud-hint bud-fill">{text}</p>;
  if (!target || !selected) return hint('To copy an amount to all later months, select it first.');
  const { name, month, cents, later } = target;
  if (later.length === 0) return hint(`${formatMonth(month)} is the last month shown.`);
  if (cents === null) return hint(`${name} has no amount in ${formatMonth(month)} to copy.`);
  const count = `${later.length} later month${later.length === 1 ? '' : 's'}`;
  return (
    <div className="bud-actions bud-fill">
      {asked === key ? (
        <>
          <span role="status">Replace {name} in {later.length === 1 ? 'the month' : `all ${later.length} months`} after {formatMonth(month)} with {formatCents(cents)}?</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving}
            onClick={() => { setAsked(null); onFill(selected.categoryId, later, cents); }}>Replace</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAsked(null)}>Keep</button>
        </>
      ) : (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAsked(key)}>
          Copy {name}, {formatCents(cents)}, to the {count}
        </button>
      )}
    </div>
  );
}

export function PlanGrid({ plan, current, saving = false, onSet, onType, onFill, onAddMonths }: {
  plan: BudgetPlan & Partial<Pick<FullPlan, 'projection' | 'truncated'>>;
  /** This month, marked in the headings and scrolled into view. */
  current?: string;
  /** An edit is still being saved. */
  saving?: boolean;
  onSet: (categoryId: string, month: string, cents: number | null) => void;
  onType?: (categoryId: string, kind: CategoryKind) => void;
  onFill?: (categoryId: string, months: string[], cents: number) => void;
  onAddMonths?: (count: number) => void;
}) {
  const [selected, setSelected] = useState<Selected | null>(null);
  const groups = ORDER.map(kind => ({ kind, rows: plan.categories.filter(c => c.kind === kind) })).filter(g => g.rows.length > 0);
  const income = plan.categories.filter(c => c.kind === 'income');
  const out = plan.categories.filter(c => c.kind !== 'income');
  const projection = plan.projection ?? null;

  const scroller = useRef<HTMLDivElement>(null);
  const shown = useRef(0);
  const count = plan.months.length;
  // On arrival this month is brought beside the category names; months added later are scrolled to.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    if (shown.current === 0) {
      const now = box.querySelector<HTMLElement>('thead th.is-current');
      const names = box.querySelector<HTMLElement>('thead th:first-child');
      // Measured as drawn: a pinned cell's offsetLeft is not its distance from the start of the table.
      if (now && names) box.scrollLeft += now.getBoundingClientRect().left - names.getBoundingClientRect().right;
    } else if (count > shown.current) box.scrollLeft = box.scrollWidth;
    shown.current = count;
  }, [count, groups.length]);

  return (
    <section className="dash-card" aria-labelledby="bud-plan-h">
      <div className="dash-card-head">
        <h2 id="bud-plan-h" className="dash-card-title">Budget by month</h2>
        {onAddMonths && groups.length > 0 && (
          <div className="bud-actions">
            <button type="button" className="btn btn-secondary btn-sm" disabled={count >= MAX_GRID_MONTHS} onClick={() => onAddMonths(1)}>Add a month</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={count >= MAX_GRID_MONTHS} onClick={() => onAddMonths(12)}>Add a year</button>
          </div>
        )}
      </div>
      {plan.truncated && <p className="bud-hint" role="status">The budget is longer than this page shows: {formatMonth(plan.months[0]!)} to {formatMonth(plan.months[count - 1]!)} is shown.</p>}
      {groups.length === 0 ? <p className="bud-hint">No categories yet. Add one below, or attach your budget in Chat and ask for categories.</p> : (
        <>
          <NetWorthNote projection={projection} asBudgeted />
          {onFill && <FillForward plan={plan} selected={selected} saving={saving} onFill={onFill} />}
          <div className="bud-plan-scroll" ref={scroller}><table className="bud-table bud-plan">
            <thead>
              <tr>
                <th scope="col">Category</th>
                {plan.months.map(m => (
                  <th key={m} scope="col" className={`bud-right${m === current ? ' is-current' : ''}`} aria-current={m === current ? 'date' : undefined}>{formatMonth(m)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment key={g.kind}>
                  <tr className="bud-plan-group"><th scope="rowgroup" colSpan={count + 1}><span>{KIND_LABEL[g.kind]}</span></th></tr>
                  {g.rows.map(c => (
                    <tr key={c.categoryId}>
                      <th scope="row" className="bud-name">
                        {c.name}
                        {onType && (
                          <select className="chat-proposal-type" value={c.kind} aria-label={`Type of ${c.name}`}
                            onChange={e => onType(c.categoryId, e.target.value as CategoryKind)}>
                            {ORDER.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                          </select>
                        )}
                      </th>
                      {plan.months.map((m, i) => (
                        <td key={m} className="bud-right" onFocus={() => setSelected({ categoryId: c.categoryId, month: m })}>
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
            {netWorthRows(projection, plan.months)}
          </table></div>
        </>
      )}
    </section>
  );
}
