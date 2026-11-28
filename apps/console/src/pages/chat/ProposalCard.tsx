// What the assistant proposes to change in the budget, drawn from what the server stored, not from what the assistant
// said. The owner can edit any amount; nothing changes until they press Apply or reply "yes".

import { formatCents, formatMonth, KIND_LABEL, type CategoryKind } from '../budget-utils.js';
import { AmountInput } from '../AmountInput.js';
import { NetWorthNote, netWorthRows } from './ProposalNetWorth.js';
import type { Projection, Proposal, ProposedRow } from './proposal-client.js';

const WHAT: Record<ProposedRow['action'], string> = { create: 'New', update: 'Change', archive: 'Archive' };

function describe(row: ProposedRow): string {
  const parts = [WHAT[row.action]];
  if (row.renameFrom) parts.push(`renamed from ${row.renameFrom}`);
  if (row.previousKind && row.previousKind !== row.kind) parts.push(`was ${KIND_LABEL[row.previousKind].toLowerCase()}`);
  return parts.join(', ');
}

export function ProposalCard({ proposal, projection, outcome, error, busy, invalid, onEdit, onType, onBad, onApply, onDiscard, onDismiss }: {
  proposal: Proposal | null; projection: Projection | null; outcome: string | null; error: string | null; busy: boolean;
  onType: (name: string, type: CategoryKind) => void;
  /** Some box holds text that is not an amount. */
  invalid: boolean;
  onEdit: (name: string, month: string, cents: number | null) => void;
  onBad: (cell: string, bad: boolean) => void;
  onApply: () => void; onDiscard: () => void; onDismiss: () => void;
}) {
  if (!proposal) {
    if (!outcome && !error) return null;
    return (
      <div className="chat-proposal" role="status">
        {outcome && <span>{outcome} <a href="/budget/budgets">Open Budgets</a></span>}
        {error && <span className="bud-error">{error}</span>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>Close</button>
      </div>
    );
  }
  const months = [...new Set(proposal.rows.flatMap(r => r.amounts.map(a => a.month)))].sort();
  const worth = netWorthRows(projection, months);
  return (
    <section className="chat-proposal is-waiting" aria-labelledby="proposal-h">
      <h2 id="proposal-h" className="dash-card-title">Proposed budget changes: {proposal.rows.length}</h2>
      <p className="bud-hint">Nothing has changed yet. Edit any amount, then reply “yes” or press Apply.</p>
      <NetWorthNote projection={projection} />
      <div className="chat-proposal-scroll"><table className="bud-table">
        <thead>
          <tr><th scope="col">Category</th>{months.map(m => <th key={m} scope="col" className="bud-right">{formatMonth(m)}</th>)}</tr>
        </thead>
        <tbody>
          {proposal.rows.map(row => (
            // Keyed to the proposal too: a replacement must not inherit what was typed into this one.
            <tr key={`${proposal.id} ${row.name}`}>
              <th scope="row" className="bud-name">
                {row.name}
                {/* Under the name, to leave the width for the months. */}
                <span className="bud-hint chat-proposal-what">
                  {row.action === 'archive' ? KIND_LABEL[row.kind] : (
                    <select className="chat-proposal-type" value={row.kind} aria-label={`Type of ${row.name}`}
                      onChange={e => onType(row.name, e.target.value as CategoryKind)}>
                      {(Object.keys(KIND_LABEL) as CategoryKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                  )} · {describe(row)}
                </span>
              </th>
              {months.map(m => {
                const a = row.amounts.find(x => x.month === m);
                return (
                  <td key={m} className="bud-right">
                    {row.action === 'archive' ? '—' : (
                      <AmountInput label={`${row.name}, ${formatMonth(m)}`} cents={a?.cents ?? null}
                        placeholder={row.action === 'update' ? 'no change' : '—'}
                        onSet={cents => onEdit(row.name, m, cents)} onBad={bad => onBad(`${proposal.id} ${row.name} ${m}`, bad)} />
                    )}
                    {a && a.was !== null && <span className="bud-hint chat-proposal-was">was {formatCents(a.was)}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {worth}
      </table></div>
      {invalid && <p className="bud-error" role="alert">Fix the highlighted amount to apply.</p>}
      {error && <p className="bud-error" role="alert">{error}</p>}
      <div className="bud-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || invalid} onClick={onApply}>{busy ? 'Working…' : 'Apply'}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onDiscard}>Discard</button>
      </div>
    </section>
  );
}
