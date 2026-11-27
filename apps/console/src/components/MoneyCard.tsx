import { formatCents, barPercent, STATUS_LABEL, type BudgetStatus, type MoneySummary } from '../pages/budget-utils';

// Status is shown three ways, never by colour alone: a shape, a word, and the bar length.
const STATUS_SHAPE: Record<BudgetStatus, string> = { under: '●', near: '▲', over: '■' };

export function StatusMark({ status }: { status: BudgetStatus }) {
  return (
    <span className={`bud-status bud-${status}`}>
      <span aria-hidden="true">{STATUS_SHAPE[status]}</span> {STATUS_LABEL[status]}
    </span>
  );
}

export function BudgetBar({ spentCents, budgetCents, label, status = 'under' }: { spentCents: number; budgetCents: number; label: string; status?: BudgetStatus }) {
  const ratio = budgetCents > 0 ? spentCents / budgetCents : spentCents > 0 ? Infinity : 0;
  const pct = barPercent(ratio);
  return (
    <div
      className={`bud-bar bud-bar-${status}`}
      role="progressbar"
      aria-label={`${label}: ${formatCents(spentCents)} of ${formatCents(budgetCents)} spent`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="bud-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Compact "Money" card for the morning brief: top categories plus a count of items that need the owner.
 * Pure: it takes a summary as a prop and does no fetching, so the same component can later be shown elsewhere.
 */
export function MoneyCard({ summary }: { summary: MoneySummary }) {
  return (
    <section className="dash-card" aria-label="Money">
      <div className="dash-card-head">
        <h3 className="dash-card-title">Money</h3>
        <span className="dash-count" aria-label={`${summary.needsYouCount} items need you`}>
          {summary.needsYouCount} need you
        </span>
      </div>
      {summary.top.length === 0 ? (
        <p className="dash-card-quiet">No budgets yet.</p>
      ) : (
        <ul className="bud-list">
          {summary.top.map(c => (
            <li key={c.id} className="bud-mini">
              <div className="bud-mini-row">
                <span className="bud-name">{c.name}</span>
                <span className="bud-num">{formatCents(c.spentCents)} / {formatCents(c.budgetCents)}</span>
              </div>
              <BudgetBar spentCents={c.spentCents} budgetCents={c.budgetCents} label={c.name} status={c.status} />
              <StatusMark status={c.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
