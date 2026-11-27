import { isMonth, shiftMonth } from './budget-utils.js';

/** Previous and next buttons around a labelled month input. */
export function MonthPicker({ month, onMonth }: { month: string; onMonth: (month: string) => void }) {
  return (
    <div className="bud-month" role="group" aria-label="Month">
      <button type="button" className="btn btn-secondary btn-sm" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}>‹</button>
      <label>
        <span className="bud-sr">Month</span>
        <input className="bud-input" type="month" value={month} onChange={e => { if (isMonth(e.target.value)) onMonth(e.target.value); }} />
      </label>
      <button type="button" className="btn btn-secondary btn-sm" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}>›</button>
    </div>
  );
}
