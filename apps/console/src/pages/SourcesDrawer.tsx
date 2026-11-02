import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import { STATUS_LABEL, categoryLabel, sourcesSummary, type ImportSourceRow } from './sources-utils.js';

// The Contacts page "Sources" drawer: every place the contact import reads people from, and whether it will.
// Read-only. A mailbox's Work/Personal category is set on Command Hub (the Android launcher) and only shown here.

interface Props {
  onClose: () => void;
}

export default function SourcesDrawer({ onClose }: Props) {
  const [rows, setRows] = useState<ImportSourceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/contacts/import/sources')
      .then(async res => {
        if (cancelled) return;
        if (!res.ok) { setError(`Could not load the sources (HTTP ${res.status})`); return; }
        const d = await res.json() as { sources: ImportSourceRow[] };
        setRows(d.sources);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError('Could not load the sources');
        console.error('[SourcesDrawer] failed to load sources:', err);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <aside className="drawer" aria-label="Import sources">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span className="badge badge-person">sources</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">Import sources</h2>
        <div className="drawer-subtitle">{rows ? sourcesSummary(rows) : 'Where contacts are read from'}</div>
      </div>

      <div className="drawer-body">
        {error && <p style={{ color: 'var(--app-destructive)', fontSize: 13, margin: 0 }}>{error}</p>}
        {!rows && !error && <p style={{ color: 'var(--app-fg-muted)', fontSize: 13, margin: 0 }}>Loading…</p>}
        {rows && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
            {rows.map(r => {
              const cat = categoryLabel(r.category);
              return (
                <li key={r.key} style={{ border: '1px solid var(--app-border)', borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 13 }}>{r.label}</strong>
                    <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: r.willImport ? 'var(--app-fg)' : 'var(--app-fg-muted)' }}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  {r.address && <div style={{ fontSize: 12, color: 'var(--app-fg-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{r.address}</div>}
                  {cat && <div style={{ fontSize: 12, marginTop: 4 }}>Category: {cat} <span style={{ color: 'var(--app-fg-muted)' }}>(set on Command Hub)</span></div>}
                  <div style={{ fontSize: 12, color: 'var(--app-fg-muted)', marginTop: 4 }}>
                    {r.note}
                    {r.linkTo && <> <a href={r.linkTo}>Open API Connections</a></>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
