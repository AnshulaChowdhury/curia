// A money box that saves when the reader moves on or presses Enter. Text that is not an amount is marked and not saved.

import { useState } from 'react';
import { centsToDollarInput, parseDollarsToCents } from './budget-utils.js';

export function AmountInput({ label, cents, placeholder, onSet, onBad }: {
  label: string; cents: number | null; placeholder?: string;
  onSet: (cents: number | null) => void;
  /** Told when the box starts or stops holding something unreadable. */
  onBad?: (bad: boolean) => void;
}) {
  const shown = cents === null ? '' : centsToDollarInput(cents);
  const [bad, setBad] = useState(false);
  const mark = (next: boolean) => { if (next !== bad) { setBad(next); onBad?.(next); } };
  function commit(input: HTMLInputElement) {
    const typed = input.value.trim();
    if (typed === shown) { mark(false); return; }
    const next = typed === '' ? null : parseDollarsToCents(typed);
    if (typed !== '' && next === null) { mark(true); return; }
    mark(false);
    if (next !== cents) onSet(next);
  }
  return (
    // Re-created when the saved amount changes, so the box never shows a stale figure.
    <input key={shown} className="bud-input bud-plan-input" type="text" inputMode="decimal" defaultValue={shown} placeholder={placeholder} aria-label={label}
      aria-invalid={bad ? true : undefined} title={bad ? 'Enter an amount like 250 or 250.00.' : undefined}
      onBlur={e => commit(e.currentTarget)} onKeyDown={e => { if (e.key === 'Enter') commit(e.currentTarget); }} />
  );
}
