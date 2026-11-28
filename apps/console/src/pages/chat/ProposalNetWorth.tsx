// Where net worth heads, under a table of months: if the proposal on the card is approved, or, on the Budgets page, if
// the budget holds. A line above the table and two rows pinned under it. All the figures come from the server, which
// works them out again each time an edit is saved.

import { formatCents, formatMonth } from '../budget-utils.js';
import type { Projection } from './proposal-client.js';

export function NetWorthNote({ projection, asBudgeted = false }: {
  projection: Projection | null;
  /** The figures are for the budget as it stands, not for changes waiting to be approved. */
  asBudgeted?: boolean;
}) {
  if (!projection) return null;
  const { today, leftOut, months } = projection;
  const end = months.at(-1);
  return (
    <div className="chat-proposal-worth" role="status">
      <p>
        {today && end?.netWorthCents != null
          ? <>Net worth today <strong>{formatCents(today.netWorthCents)}</strong>, projected <strong>{formatCents(end.netWorthCents)}</strong> by the end of {formatMonth(end.month)}.</>
          : end ? <>Add balances on the budget Overview to see net worth. This budget changes it by <strong>{formatCents(end.changeCents)}</strong> by the end of {formatMonth(end.month)}.</> : null}
      </p>
      <p className="bud-hint">
        {asBudgeted ? 'If the budget holds' : 'If approved'}: today’s balances plus income minus expenses. Savings and debt paydown are kept. No interest or growth.
        {today && leftOut > 0 ? ` ${leftOut} account${leftOut === 1 ? '' : 's'} with no CAD balance left out.` : ''}
      </p>
    </div>
  );
}

/** Table rows under the categories, lined up with the month columns. A month that is not projected shows a dash. */
export function netWorthRows(projection: Projection | null, months: string[]) {
  if (!projection || projection.months.length === 0) return null;
  const at = new Map(projection.months.map(m => [m.month, m]));
  const known = projection.today !== null;
  const cell = (month: string, cents: number | null | undefined) => (
    <td key={month} className="bud-right">{cents === null || cents === undefined ? '—' : formatCents(cents)}</td>
  );
  return (
    <tfoot>
      <tr>
        <th scope="row">Income less expenses</th>
        {months.map(m => { const p = at.get(m); return cell(m, p ? p.incomeCents - p.expenseCents : null); })}
      </tr>
      <tr>
        <th scope="row">{known ? 'Net worth at month end' : 'Change from today'}</th>
        {months.map(m => cell(m, known ? at.get(m)?.netWorthCents : at.get(m)?.changeCents))}
      </tr>
    </tfoot>
  );
}
