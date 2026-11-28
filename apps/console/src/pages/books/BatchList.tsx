// The list of books batches. Completed ones are left out unless asked for.

import type { BatchSummary } from './batch-types.js';
import { formatDate } from './batch-types.js';

const muted = { padding: 24, fontSize: 13, color: 'var(--app-fg-muted)' } as const;
const right = { textAlign: 'right' } as const;

export function BatchStatusPill({ status }: { status: BatchSummary['status'] }) {
  return status === 'complete'
    ? <span className="status-pill completed">Complete</span>
    : <span className="status-pill pending">Open</span>;
}

export function BatchList({ batches, showCompleted, onShowCompleted, onOpen }: {
  batches: BatchSummary[];
  showCompleted: boolean;
  onShowCompleted: (show: boolean) => void;
  onOpen: (batchId: string) => void;
}) {
  if (batches.length === 0) {
    return <div style={muted}>No batches yet. Upload the week&apos;s RBC download files above; the books run turns them into a batch here.</div>;
  }
  const completed = batches.filter(b => b.status === 'complete').length;
  const shown = showCompleted ? batches : batches.filter(b => b.status !== 'complete');
  return (
    <>
      <div className="records-toolbar">
        <div className="records-toolbar-left">
          <h3 className="settings-section-title">Batches</h3>
          <span className="topbar-meta">{batches.length - completed} open, {completed} complete</span>
        </div>
        <div className="records-toolbar-right">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={showCompleted} onChange={e => onShowCompleted(e.target.checked)} />
            Show completed
          </label>
        </div>
      </div>
      {shown.length === 0 ? <div style={muted}>All batches are complete. Tick “Show completed” to see them.</div> : (
        <table className="records-table">
          <thead>
            <tr><th>Batch</th><th>Created</th><th>Status</th><th style={right}>Rows</th><th style={right}>To review</th><th style={right}>Approved</th><th style={right}>Posted</th><th style={right}>Failed / by hand</th></tr>
          </thead>
          <tbody>
            {shown.map(b => (
              <tr key={b.batch_id} onClick={() => onOpen(b.batch_id)} style={{ cursor: 'pointer' }}>
                <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>{b.batch_id.slice(0, 8)}</td>
                <td>{formatDate(b.created_at)}</td>
                <td><BatchStatusPill status={b.status} /></td>
                <td style={right}>{b.rows}</td>
                <td style={right}>{b.pending}</td>
                <td style={right}>{b.approved}</td>
                <td style={right}>{b.posted}</td>
                <td style={right}>{b.failed + b.manual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
