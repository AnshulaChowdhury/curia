import { useState, useEffect, useCallback } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';
import ConnectionCard from './ConnectionCard.js';
import InboxTriageCard from './InboxTriageCard.js';
import MatrixBridgesCard from './MatrixBridgesCard.js';
import ContactsImportCard from './ContactsImportCard.js';

// Mirrors GET /api/connections (src/channels/http/routes/quickbooks.ts). Secrets and tokens are never returned.
interface Connection {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  settingsSource?: 'vault' | 'env';
  redirectUri?: string;
  clientIdHint?: string;
  connected: boolean;
  environment?: string;
  realmId?: string;
  connectedAt?: string;
  refreshExpiresAt?: string;
  booksTokenSet: boolean;
  connectUrl: string;
}

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

async function errorText(res: Response): Promise<string> {
  try {
    const d = await res.json() as { error?: string };
    if (d.error) return d.error;
  } catch { /* fall through */ }
  return `HTTP ${res.status}`;
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--app-fg-muted)' } as const;
const inputStyle = {
  padding: '8px 10px', fontSize: 13, borderRadius: 6, border: '1px solid var(--app-input-bd)',
  background: 'var(--app-card)', color: 'var(--app-fg)', fontFamily: 'inherit',
} as const;

function QuickbooksCard({ c, reload }: { c: Connection; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(!c.configured);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(c.redirectUri ?? `${window.location.origin}/books/qbo-callback`);
  const [environment, setEnvironment] = useState(c.environment ?? 'production');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/connections/quickbooks/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, redirectUri, environment }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      setClientId('');
      setClientSecret('');
      setEditing(false);
      setMessage({ text: 'Saved. Press Connect to authorise QuickBooks.', error: false });
      await reload();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Could not save', error: true });
    } finally {
      setSaving(false);
    }
  }

  async function makeToken() {
    setMessage(null);
    try {
      const res = await apiFetch('/api/connections/books-token', { method: 'POST' });
      if (!res.ok) throw new Error(await errorText(res));
      const d = await res.json() as { token: string };
      setNewToken(d.token);
      await reload();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Could not make a token', error: true });
    }
  }

  const muted = { color: 'var(--app-fg-muted)' } as const;
  return (
    <ConnectionCard
      title={<>
        {c.name}{' '}
        <span className={`status-pill${c.connected ? ' confirmed' : c.configured ? ' provisional' : ''}`}>
          {c.connected ? 'Connected' : c.configured ? 'Not connected' : 'Not set up'}
        </span>
      </>}
      sub={c.description}
    >
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        {message && <div style={{ color: message.error ? 'var(--app-destructive)' : 'var(--app-fg)' }}>{message.text}</div>}

        {/* Step 1: the Intuit app's keys */}
        <div style={{ fontWeight: 600 }}>1. The Intuit app</div>
        {c.configured && !editing ? (
          <div style={muted}>
            Client ID {c.clientIdHint} ({c.environment}), redirect {c.redirectUri}
            {c.settingsSource === 'env' ? ', set in Railway' : ''}.{' '}
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>Change</button>
          </div>
        ) : (
          <form
            onSubmit={e => { e.preventDefault(); void save(); }}
            style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}
          >
            <div style={muted}>
              From developer.intuit.com: your app &rarr; Keys &amp; credentials &rarr; Production. Add the redirect address below to the
              app&apos;s Redirect URIs first. The secret is stored encrypted and never shown again.
            </div>
            <label style={fieldStyle}>Client ID
              <input style={inputStyle} value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label style={fieldStyle}>Client secret
              <input style={inputStyle} type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} autoComplete="new-password" />
            </label>
            <label style={fieldStyle}>Redirect address (add this exact address in the Intuit app)
              <input style={inputStyle} value={redirectUri} onChange={e => setRedirectUri(e.target.value)} spellCheck={false} />
            </label>
            <label style={fieldStyle}>Environment
              <select style={inputStyle} value={environment} onChange={e => setEnvironment(e.target.value)}>
                <option value="production">Production (the real company)</option>
                <option value="sandbox">Sandbox (test company)</option>
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={saving || !clientId.trim() || !clientSecret.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {c.configured && <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>}
            </div>
          </form>
        )}

        {/* Step 2: authorise */}
        <div style={{ fontWeight: 600 }}>2. Authorise QuickBooks</div>
        {c.connected ? (
          <div style={muted}>
            {c.environment} company {c.realmId}, connected {formatDate(c.connectedAt)}. Authorisation good until{' '}
            {formatDate(c.refreshExpiresAt)}; it renews each time the books run.
          </div>
        ) : (
          <div style={muted}>{c.configured ? 'Sign in to Intuit as an admin of the company.' : 'Save the app\'s keys first.'}</div>
        )}
        {c.configured && (
          <div>
            <a className={`btn ${c.connected ? 'btn-secondary' : 'btn-primary'}`} href={c.connectUrl}>
              {c.connected ? 'Reconnect' : 'Connect'}
            </a>
          </div>
        )}

        {/* Step 3: the books agent's token */}
        <div style={{ fontWeight: 600 }}>3. Books agent token</div>
        <div style={muted}>
          The books agent on the Mac mini uses this to reach QuickBooks through Curia. It can do nothing else. It is shown once, so copy it
          straight into the books user&apos;s secrets file as BOOKS_API_TOKEN. Making a new one stops the old one working.
        </div>
        {newToken && (
          <div>
            <code style={{ display: 'block', padding: 10, borderRadius: 6, background: 'var(--app-muted)', wordBreak: 'break-all', userSelect: 'all' }}>
              {newToken}
            </code>
            <div style={{ ...muted, marginTop: 4 }}>Copy it now; it will not be shown again.</div>
          </div>
        )}
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => void makeToken()}>
            {c.booksTokenSet ? 'Make a new token' : 'Make a token'}
          </button>
          {c.booksTokenSet && !newToken && <span style={{ ...muted, marginLeft: 10 }}>A token is set.</span>}
        </div>
      </div>
    </ConnectionCard>
  );
}

interface DriveStatus {
  configured: boolean;
  serviceAccountEmail?: string;
  folderName?: string;
  reachable?: boolean;
  problem?: string;
}

/** The service account's address from the pasted key, so the page can say who to share the folder with. */
function emailFromKey(json: string): string | null {
  try {
    const email = (JSON.parse(json) as { client_email?: unknown }).client_email;
    return typeof email === 'string' ? email : null;
  } catch {
    return null;
  }
}

function DriveCard() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [keyJson, setKeyJson] = useState('');
  const [folder, setFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/connections/drive');
      if (!res.ok) throw new Error(await errorText(res));
      const st = await res.json() as DriveStatus;
      setStatus(st);
      setEditing(!st.configured);
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Failed to load', error: true });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/connections/drive/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceAccountJson: keyJson, folder }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      setKeyJson('');
      setFolder('');
      setMessage({ text: 'Saved. Curia can open the folder.', error: false });
      await load();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Could not save', error: true });
    } finally {
      setSaving(false);
    }
  }

  const muted = { color: 'var(--app-fg-muted)' } as const;
  const keyEmail = emailFromKey(keyJson);
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">
          Google Drive: bank files{' '}
          <span className={`status-pill${status?.configured ? (status.reachable ? ' confirmed' : ' provisional') : ''}`}>
            {!status ? '…' : !status.configured ? 'Not set up' : status.reachable ? 'Connected' : 'Folder not reachable'}
          </span>
        </h3>
        <p className="settings-section-sub">
          The folder where the RBC download files (.qbo) are dropped each week. Curia can see only this folder, and hands the files to the books agent.
        </p>
      </div>
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        {message && <div style={{ color: message.error ? 'var(--app-destructive)' : 'var(--app-fg)' }}>{message.text}</div>}
        {status?.configured && !editing ? (
          <div style={muted}>
            {status.reachable ? <>Folder &ldquo;{status.folderName}&rdquo;, read as {status.serviceAccountEmail}. </> : <>{status.problem} </>}
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>Change</button>
          </div>
        ) : (
          <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
            <div style={muted}>
              In Google Cloud, create a service account, enable the Google Drive API for the project, and download the account&apos;s JSON key.
              Then share your bank files folder with the account&apos;s email address (Editor, so it can move finished files to a Processed folder).
            </div>
            <label style={fieldStyle}>Service account key (the JSON file&apos;s contents)
              <textarea style={{ ...inputStyle, minHeight: 90, fontFamily: 'monospace', fontSize: 12 }} value={keyJson} onChange={e => setKeyJson(e.target.value)} spellCheck={false} autoComplete="off" />
            </label>
            {keyEmail && <div style={muted}>Share the folder with <strong>{keyEmail}</strong> before you save.</div>}
            <label style={fieldStyle}>Folder link (from Google Drive: Share &rarr; Copy link)
              <input style={inputStyle} value={folder} onChange={e => setFolder(e.target.value)} spellCheck={false} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={saving || !keyJson.trim() || !folder.trim()}>{saving ? 'Checking…' : 'Save'}</button>
              {status?.configured && <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

interface BooksStatus {
  heartbeat: { lastSeenAt: string; ageMinutes: number; state: string | null; version: string | null } | null;
  lastRun: { receivedAt: string; status: string; batchId: string | null } | null;
  week: { since: string; expectedAccounts: string[]; received: string[]; missing: string[] };
  jobs: {
    reminder: { cronExpr: string; timezone: string; enabled: boolean } | null;
    deadline: { cronExpr: string; timezone: string; enabled: boolean } | null;
  };
  lastNotifiedAt: string | null;
}

interface Reviewer {
  name: string;
  email?: string;
  ntfyTopic?: string;
}

function ageText(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.round(minutes / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Books monitoring: is the Mac mini checking in, did this week's files arrive, who gets told when they don't. */
function BooksMonitorCard() {
  const [status, setStatus] = useState<BooksStatus | null>(null);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([apiFetch('/api/books/status'), apiFetch('/api/books/reviewers')]);
      if (!s.ok) throw new Error(await errorText(s));
      if (!r.ok) throw new Error(await errorText(r));
      setStatus(await s.json() as BooksStatus);
      setReviewers((await r.json() as { reviewers: Reviewer[] }).reviewers);
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Failed to load', error: true });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const update = (i: number, patch: Partial<Reviewer>) => setReviewers(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/books/reviewers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewers }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      setReviewers((await res.json() as { reviewers: Reviewer[] }).reviewers);
      setMessage({ text: 'Saved.', error: false });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Could not save', error: true });
    } finally {
      setSaving(false);
    }
  }

  const muted = { color: 'var(--app-fg-muted)' } as const;
  const hb = status?.heartbeat;
  const silent = hb ? hb.ageMinutes >= 60 : false;
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">Books: deadlines and alerts</h3>
        <p className="settings-section-sub">
          Curia tells the reviewers when the weekly files are missing, a run fails, a file sits unprocessed, or the Mac mini goes quiet.
          The reminder (Monday) and deadline (Tuesday) times are scheduled jobs: change or pause them in Scheduled Jobs.
        </p>
      </div>
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        {message && <div style={{ color: message.error ? 'var(--app-destructive)' : 'var(--app-fg)' }}>{message.text}</div>}
        {status && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div>
              Mac mini:{' '}
              {hb ? <span style={silent ? { color: 'var(--app-destructive)' } : undefined}>checked in {ageText(hb.ageMinutes)}{hb.state ? ` (${hb.state})` : ''}</span>
                  : <span style={muted}>has not checked in yet</span>}
            </div>
            <div>
              Last run:{' '}
              {status.lastRun ? <>{status.lastRun.status}, {formatDate(status.lastRun.receivedAt)}</> : <span style={muted}>none yet</span>}
            </div>
            <div>
              This week&apos;s files:{' '}
              {status.week.expectedAccounts.length === 0 ? <span style={muted}>no run has named the accounts yet</span>
                : status.week.missing.length === 0 ? <>all in ({status.week.received.join(', ')})</>
                : <span style={{ color: 'var(--app-destructive)' }}>missing {status.week.missing.join(', ')}</span>}
            </div>
            <div style={muted}>
              Reminder: {status.jobs.reminder ? `${status.jobs.reminder.cronExpr} (${status.jobs.reminder.timezone})${status.jobs.reminder.enabled ? '' : ', paused'}` : 'not scheduled yet'}
              {' · '}
              Deadline: {status.jobs.deadline ? `${status.jobs.deadline.cronExpr} (${status.jobs.deadline.timezone})${status.jobs.deadline.enabled ? '' : ', paused'}` : 'not scheduled yet'}
              {status.lastNotifiedAt ? ` · last alert ${formatDate(status.lastNotifiedAt)}` : ''}
            </div>
          </div>
        )}
        <div style={{ fontWeight: 600 }}>Reviewers to notify</div>
        <div style={muted}>
          Push alerts go to the ntfy topic you give (a topic name on the ntfy server used for inbox triage, or a full https address).
          Alerts name accounts and weeks only, never amounts or bank text. Email alerts are not sent yet.
        </div>
        {reviewers.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={fieldStyle}>Name<input style={inputStyle} value={r.name} onChange={e => update(i, { name: e.target.value })} /></label>
            <label style={fieldStyle}>Email<input style={inputStyle} value={r.email ?? ''} onChange={e => update(i, { email: e.target.value })} /></label>
            <label style={fieldStyle}>ntfy topic<input style={inputStyle} value={r.ntfyTopic ?? ''} onChange={e => update(i, { ntfyTopic: e.target.value })} spellCheck={false} /></label>
            <button type="button" className="btn btn-secondary" onClick={() => setReviewers(rs => rs.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={() => setReviewers(rs => [...rs, { name: '' }])}>Add a reviewer</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save reviewers'}</button>
        </div>
      </div>
    </section>
  );
}

export default function ConnectionsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiFetch('/api/connections', { signal });
      if (!res.ok) throw new Error(await errorText(res));
      const data = await res.json() as { connections: Connection[] };
      setConnections(data.connections ?? []);
      setLoadError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setLoadError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="connections" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
        <main className="main">
          <Topbar crumb="Settings" title="API connections" />
          <div className="settings-content">
            <div className="settings-page-header">
              <h2 className="settings-page-title">API connections</h2>
              <p className="settings-page-sub">
                Outside services Curia is authorised to use. Curia keeps the keys and tokens encrypted and refreshes them; they are never shown here.
              </p>
            </div>
            {loadError && <div style={{ color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>}
            {connections.map(c => <QuickbooksCard key={c.id} c={c} reload={() => load()} />)}
            <DriveCard />
            <BooksMonitorCard />
            <InboxTriageCard />
            <MatrixBridgesCard />
            <ContactsImportCard />
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
