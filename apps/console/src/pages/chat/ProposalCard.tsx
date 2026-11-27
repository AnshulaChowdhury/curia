// What the assistant proposes to change in the budget, drawn from what the server stored, not from what the assistant
// said. Nothing changes until the owner presses Apply or replies "yes".

import { formatCents, formatMonth, KIND_LABEL } from '../budget-utils.js';
import type { Proposal, ProposedRow } from './proposal-client.js';

const WHAT: Record<ProposedRow['action'], string> = { create: 'New', update: 'Change', archive: 'Archive' };

function describe(row: ProposedRow): string {
  const parts = [WHAT[row.action]];
  if (row.renameFrom) parts.push(`renamed from ${row.renameFrom}`);
  if (row.previousKind && row.previousKind !== row.kind) parts.push(`was ${KIND_LABEL[row.previousKind].toLowerCase()}`);
  return parts.join(', ');
}

export function ProposalCard({ proposal, outcome, error, busy, onApply, onDiscard, onDismiss }: {
  proposal: Proposal | null; outcome: string | null; error: string | null; busy: boolean;
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
  return (
    <section className="chat-proposal is-waiting" aria-labelledby="proposal-h">
      <h2 id="proposal-h" className="dash-card-title">Proposed budget changes: {proposal.rows.length}</h2>
      <p className="bud-hint">Nothing has changed yet. Reply “yes” or press Apply.</p>
      <div className="chat-proposal-scroll"><table className="bud-table">
        <thead>
          <tr><th scope="col">Category</th><th scope="col">Type</th><th scope="col">What</th>{months.map(m => <th key={m} scope="col" className="bud-right">{formatMonth(m)}</th>)}</tr>
        </thead>
        <tbody>
          {proposal.rows.map(row => (
            <tr key={row.name}>
              <td className="bud-name">{row.name}</td>
              <td>{KIND_LABEL[row.kind]}</td>
              <td>{describe(row)}</td>
              {months.map(m => {
                const a = row.amounts.find(x => x.month === m);
                return (
                  <td key={m} className="bud-right">
                    {a ? formatCents(a.cents) : '—'}
                    {a && a.was !== null && <span className="bud-hint"> was {formatCents(a.was)}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table></div>
      {error && <p className="bud-error" role="alert">{error}</p>}
      <div className="bud-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onApply}>{busy ? 'Working…' : 'Apply'}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onDiscard}>Discard</button>
      </div>
    </section>
  );
}
