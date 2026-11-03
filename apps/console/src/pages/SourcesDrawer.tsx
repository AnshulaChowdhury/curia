import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import {
  STATUS_LABEL, anyFarmRunning, applyOutcomeText, applyPrompt, categoryLabel, farmAction, farmName, farmStatusText, orgLine, reviewReasonText, sourcesSummary,
  type ApplyResult, type FarmMailbox, type ImportSourceRow, type OrganizationRow, type PreviewResult,
} from './sources-utils.js';

// The Contacts page "Sources" drawer: every place the contact import reads people from, and whether it will.
// Read-only. A mailbox's Work/Personal category is set on Command Hub (the Android launcher) and only shown here.

interface Props {
  onClose: () => void;
}

export default function SourcesDrawer({ onClose }: Props) {
  const [rows, setRows] = useState<ImportSourceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [farm, setFarm] = useState<FarmMailbox[] | null>(null);
  const [farmError, setFarmError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrganizationRow[] | null>(null);

  async function loadFarm() {
    try {
      const res = await apiFetch('/api/contacts/import/farm');
      if (!res.ok) { setFarmError(`Could not load the mailbox scans (HTTP ${res.status})`); return; }
      setFarm((await res.json() as { mailboxes: FarmMailbox[] }).mailboxes);
      setFarmError(null);
      const o = await apiFetch('/api/contacts/import/organizations');
      if (o.ok) setOrgs((await o.json() as { organizations: OrganizationRow[] }).organizations);
    } catch (err) {
      setFarmError('Could not load the mailbox scans');
      console.error('[SourcesDrawer] farm status failed:', err);
    }
  }

  async function startScan(accountId: string, resume: boolean) {
    setFarmError(null);
    try {
      const res = await apiFetch(`/api/contacts/import/farm/${encodeURIComponent(accountId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume }),
      });
      if (!res.ok) setFarmError(await errorOf(res));
    } catch (err) {
      setFarmError('Could not reach Curia');
      console.error('[SourcesDrawer] start scan failed:', err);
    }
    await loadFarm();
  }

  useEffect(() => { void loadFarm(); }, []);
  // While a scan runs, refresh its counts every few seconds.
  const scanning = farm ? anyFarmRunning(farm) : false;
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => void loadFarm(), 5000);
    return () => clearInterval(t);
  }, [scanning]);

  async function errorOf(res: Response): Promise<string> {
    try {
      const body = await res.json() as { error?: string };
      return body.error ?? `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  async function runPreview() {
    setBusy('preview'); setActionError(null); setOutcome(null); setPreview(null);
    try {
      const res = await apiFetch('/api/contacts/import/preview', { method: 'POST' });
      if (!res.ok) { setActionError(await errorOf(res)); return; }
      setPreview(await res.json() as PreviewResult);
    } catch (err) {
      setActionError('Could not reach Curia');
      console.error('[SourcesDrawer] preview failed:', err);
    } finally {
      setBusy(null);
    }
  }

  async function runApply() {
    if (!preview) return;
    setBusy('apply'); setActionError(null);
    try {
      const res = await apiFetch('/api/contacts/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: preview.runId }),
      });
      if (!res.ok) { setActionError(await errorOf(res)); return; }
      setOutcome(applyOutcomeText(await res.json() as ApplyResult));
      setPreview(null); // a preview can be applied once
    } catch (err) {
      setActionError('Could not reach Curia');
      console.error('[SourcesDrawer] apply failed:', err);
    } finally {
      setBusy(null);
    }
  }

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

        {farm && (
          <div style={{ marginTop: 16 }}>
            <strong style={{ fontSize: 13 }}>Mailbox scans</strong>
            <p style={{ fontSize: 12, color: 'var(--app-fg-muted)', margin: '4px 0 8px' }}>
              Reads each connected mailbox once, in the background, and keeps only counts per person. No message text is stored.
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {farm.map(m => {
                const action = farmAction(m);
                return (
                  <li key={m.accountId} style={{ border: '1px solid var(--app-border)', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <strong style={{ fontSize: 13 }}>{farmName(m.accountId)}</strong>
                      {action && (
                        <button className="btn btn-secondary btn-sm" onClick={() => void startScan(m.accountId, action.resume)}>{action.label}</button>
                      )}
                    </div>
                    <div style={{ color: 'var(--app-fg-muted)', marginTop: 4 }}>{farmStatusText(m)}</div>
                  </li>
                );
              })}
            </ul>
            {farmError && <p style={{ color: 'var(--app-destructive)', fontSize: 12, margin: '8px 0 0' }}>{farmError}</p>}
          </div>
        )}

        {orgs && orgs.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <strong style={{ fontSize: 13 }}>Organisations found ({orgs.length})</strong>
            <p style={{ fontSize: 12, color: 'var(--app-fg-muted)', margin: '4px 0 8px' }}>
              People grouped by email domain (webmail and role addresses left out). A summary only: nothing is added to Curia from it.
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {orgs.slice(0, 50).map(o => (
                <li key={o.domain} style={{ fontSize: 12 }}>
                  <strong>{o.name}</strong> <span style={{ color: 'var(--app-fg-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{o.domain}</span>
                  <div style={{ color: 'var(--app-fg-muted)' }}>{orgLine(o)}</div>
                </li>
              ))}
            </ul>
            {orgs.length > 50 && <p style={{ fontSize: 12, color: 'var(--app-fg-muted)', margin: '6px 0 0' }}>Showing the 50 largest.</p>}
          </div>
        )}

        {rows && (
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void runPreview()} disabled={busy !== null}>
              {busy === 'preview' ? 'Reading sources…' : 'Preview import'}
            </button>
            <p style={{ fontSize: 12, color: 'var(--app-fg-muted)', margin: '6px 0 0' }}>
              A preview reads the ready sources and counts what would happen. It changes nothing.
            </p>
            {actionError && <p style={{ color: 'var(--app-destructive)', fontSize: 12, margin: '8px 0 0' }}>{actionError}</p>}
            {outcome && <p style={{ fontSize: 13, margin: '8px 0 0' }}>{outcome}</p>}

            {preview && (
              <div style={{ marginTop: 12, border: '1px solid var(--app-border)', borderRadius: 6, padding: '10px 12px', fontSize: 12 }}>
                <strong style={{ fontSize: 13 }}>{preview.totals.people} people found</strong>
                <div style={{ marginTop: 4 }}>
                  {preview.totals.create} new · {preview.totals.attach} already in Curia · {preview.totals.review} need review
                  {preview.droppedNoName > 0 && ` · ${preview.droppedNoName} skipped (only a number, no name)`}
                </div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 16, color: 'var(--app-fg-muted)' }}>
                  {preview.sources.map(s => (
                    <li key={s.sourceId}>{s.label}: {s.ok ? `${s.usable} usable of ${s.read}` : s.message}</li>
                  ))}
                </ul>
                {Object.keys(preview.reviewReasons).length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 16, color: 'var(--app-fg-muted)' }}>
                    {Object.entries(preview.reviewReasons).map(([code, n]) => (
                      <li key={code}>{n} to review: {reviewReasonText(code)}</li>
                    ))}
                  </ul>
                )}
                {(['create', 'attach', 'review'] as const).map(kind => preview.sample[kind].length > 0 && (
                  <div key={kind} style={{ marginTop: 8 }}>
                    <div style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11, color: 'var(--app-fg-muted)' }}>
                      Sample: {kind === 'create' ? 'new' : kind === 'attach' ? 'already in Curia' : 'to review'}
                    </div>
                    {preview.sample[kind].map((r, i) => (
                      <div key={`${kind}-${i}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{r.name} · {r.identifier}</div>
                    ))}
                  </div>
                ))}
                <p style={{ margin: '12px 0 6px' }}>{applyPrompt(preview)}</p>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void runApply()}
                  disabled={busy !== null || preview.totals.create + preview.totals.attach === 0}
                >
                  {busy === 'apply' ? 'Applying…' : 'Apply this preview'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
