import { useState, useEffect, useCallback, useMemo } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// Mirrors GET /api/books/batches and /api/books/batches/:id (src/channels/http/routes/books-batches.ts).
// Row text comes from bank files: it is rendered as plain text by React and never as HTML.
type Decision = 'pending' | 'approved' | 'skipped';
type EditableField = 'category' | 'tax_code' | 'location' | 'class' | 'payee';

interface BatchSummary {
  batch_id: string;
  created_at: string;
  status: string;
  rows: number;
  pending: number;
  approved: number;
  skipped: number;
  posted: number;
  failed: number;
  manual: number;
}

interface RowResult {
  status: 'posted' | 'manual' | 'failed' | 'skipped';
  qbo_id?: string;
  entity?: string;
  message?: string;
}

interface Flag { kind: string; message?: string }

interface BatchRow {
  id: string;
  row: Record<string, unknown>;
  decision: Decision;
  result: RowResult | null;
}

interface BatchDetail extends Omit<BatchSummary, 'rows' | 'pending' | 'approved' | 'skipped' | 'posted' | 'failed' | 'manual'> {
  rows: BatchRow[];
}

const FIELDS: Array<{ key: EditableField; label: string }> = [
  { key: 'category', label: 'Category' },
  { key: 'tax_code', label: 'Tax code' },
  { key: 'location', label: 'Location' },
  { key: 'class', label: 'Class' },
  { key: 'payee', label: 'Payee' },
];

const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function flagsOf(row: Record<string, unknown>): Flag[] {
  return Array.isArray(row['flags']) ? (row['flags'] as Flag[]).filter(f => f && typeof f.kind === 'string') : [];
}

async function errorText(res: Response): Promise<string> {
  try {
    const d = await res.json() as { error?: string };
    if (d.error) return d.error;
  } catch { /* fall through */ }
  return `HTTP ${res.status}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatAmount(a: unknown): string {
  const n = Number(text(a));
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : text(a);
}

function ResultCell({ r }: { r: RowResult | null }) {
  if (!r) return null;
  const label = r.status === 'posted' ? `Posted${r.qbo_id ? ` (QuickBooks ${r.entity ?? 'entry'} ${r.qbo_id})` : ''}`
    : r.status === 'manual' ? 'Enter by hand'
    : r.status === 'failed' ? 'Failed'
    : 'Skipped by the agent';
  return (
    <div style={{ fontSize: 12 }}>
      <span className={`status-pill${r.status === 'posted' ? ' confirmed' : r.status === 'failed' ? ' failed' : ' provisional'}`}>{label}</span>
      {r.message && <div style={{ color: 'var(--app-fg-muted)', marginTop: 2 }}>{r.message}</div>}
    </div>
  );
}

function BatchView({ batchId, onBack }: { batchId: string; onBack: () => void }) {
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/books/batches/${encodeURIComponent(batchId)}`);
      if (!res.ok) throw new Error(await errorText(res));
      setBatch(await res.json() as BatchDetail);
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Failed to load', error: true });
    }
  }, [batchId]);
  useEffect(() => { void load(); }, [load]);

  const categories = useMemo(
    () => [...new Set((batch?.rows ?? []).map(r => text(r.row['category'])).filter(Boolean))].sort(),
    [batch],
  );

  async function saveEdit(rowId: string, field: EditableField, value: string, current: string) {
    if (value === current) return;
    setMessage(null);
    const res = await apiFetch(`/api/books/batches/${encodeURIComponent(batchId)}/rows/${encodeURIComponent(rowId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: { [field]: value } }),
    });
    if (!res.ok) setMessage({ text: await errorText(res), error: true });
    await load();
  }

  async function decide(decision: Decision) {
    if (selected.size === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch(`/api/books/batches/${encodeURIComponent(batchId)}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_ids: [...selected], decision }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      setSelected(new Set());
      await load();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Could not update', error: true });
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => setSelected(s => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (!batch) return <div style={{ padding: 24, fontSize: 13, color: message?.error ? 'var(--app-destructive)' : 'var(--app-fg-muted)' }}>{message?.text ?? 'Loading…'}</div>;

  const inputStyle = {
    width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid var(--app-input-bd)',
    background: 'var(--app-card)', color: 'var(--app-fg)', fontFamily: 'inherit',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="records-toolbar">
        <div className="records-toolbar-left">
          <button type="button" className="btn btn-secondary" onClick={onBack}>All batches</button>
          <span className="topbar-meta">Batch {batch.batch_id.slice(0, 8)}, {formatDate(batch.created_at)}, {batch.rows.length} rows</span>
        </div>
        <div className="records-toolbar-right" style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => void decide('approved')}>Approve selected</button>
          <button type="button" className="btn btn-secondary" disabled={busy || selected.size === 0} onClick={() => void decide('skipped')}>Skip selected</button>
          <button type="button" className="btn btn-secondary" disabled={busy || selected.size === 0} onClick={() => void decide('pending')}>Undo</button>
        </div>
      </div>
      {message && <div style={{ padding: '8px 20px', fontSize: 13, color: message.error ? 'var(--app-destructive)' : 'var(--app-fg)' }}>{message.text}</div>}
      <datalist id="books-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
      <div className="records-table-wrap">
        <table className="records-table">
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>Date</th>
              <th>Description</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              {FIELDS.map(f => <th key={f.key}>{f.label}</th>)}
              <th>Flags</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {batch.rows.map(r => {
              const locked = r.decision !== 'pending' || r.result?.status === 'posted';
              const flags = flagsOf(r.row);
              return (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`Select ${r.id}`} checked={selected.has(r.id)} disabled={r.result?.status === 'posted'} onChange={() => toggle(r.id)} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{text(r.row['date'])}</td>
                  <td style={{ maxWidth: 280, wordBreak: 'break-word' }}>
                    {text(r.row['description'])}
                    {text(r.row['category_source']) && <div style={{ fontSize: 11, color: 'var(--app-fg-muted)' }}>{text(r.row['category_source'])}{r.row['reason'] ? `: ${text(r.row['reason'])}` : ''}</div>}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{formatAmount(r.row['amount'])}</td>
                  {FIELDS.map(f => {
                    const value = text(r.row[f.key]);
                    return (
                      <td key={f.key} style={{ minWidth: f.key === 'category' ? 170 : 110 }}>
                        <input
                          key={`${r.id}-${f.key}-${value}`}
                          style={inputStyle}
                          defaultValue={value}
                          disabled={locked}
                          list={f.key === 'category' ? 'books-categories' : undefined}
                          aria-label={`${f.label} for ${r.id}`}
                          maxLength={200}
                          onBlur={e => void saveEdit(r.id, f.key, e.target.value.trim(), value)}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        />
                      </td>
                    );
                  })}
                  <td style={{ fontSize: 12 }}>
                    {flags.map((f, i) => (
                      <div key={i} title={f.message}><span className="status-pill blocked">{f.kind.replace(/_/g, ' ')}</span></div>
                    ))}
                  </td>
                  <td>
                    <span className={`status-pill${r.decision === 'approved' ? ' confirmed' : r.decision === 'skipped' ? ' cancelled' : ' pending'}`}>{r.decision}</span>
                    <ResultCell r={r.result} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function BooksReviewPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/books/batches');
      if (!res.ok) throw new Error(await errorText(res));
      setBatches((await res.json() as { batches: BatchSummary[] }).batches);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);
  useEffect(() => { if (!openId) void load(); }, [load, openId]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="books" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
        <main className="main">
          <Topbar title="Books" />
          {openId ? (
            <BatchView batchId={openId} onBack={() => setOpenId(null)} />
          ) : (
            <div className="records-table-wrap">
              {loadError && <div style={{ padding: 24, fontSize: 13, color: 'var(--app-destructive)' }}>{loadError}</div>}
              {batches && batches.length === 0 && (
                <div style={{ padding: 24, fontSize: 13, color: 'var(--app-fg-muted)' }}>
                  No batches yet. Drop the week&apos;s RBC download files in the bank files folder; the books run turns them into a batch here.
                </div>
              )}
              {batches && batches.length > 0 && (
                <table className="records-table">
                  <thead>
                    <tr><th>Batch</th><th>Created</th><th style={{ textAlign: 'right' }}>Rows</th><th style={{ textAlign: 'right' }}>To review</th><th style={{ textAlign: 'right' }}>Approved</th><th style={{ textAlign: 'right' }}>Posted</th><th style={{ textAlign: 'right' }}>Failed / by hand</th></tr>
                  </thead>
                  <tbody>
                    {batches.map(b => (
                      <tr key={b.batch_id} onClick={() => setOpenId(b.batch_id)} style={{ cursor: 'pointer' }}>
                        <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>{b.batch_id.slice(0, 8)}</td>
                        <td>{formatDate(b.created_at)}</td>
                        <td style={{ textAlign: 'right' }}>{b.rows}</td>
                        <td style={{ textAlign: 'right' }}>{b.pending}</td>
                        <td style={{ textAlign: 'right' }}>{b.approved}</td>
                        <td style={{ textAlign: 'right' }}>{b.posted}</td>
                        <td style={{ textAlign: 'right' }}>{b.failed + b.manual}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
