import { useState, useEffect, useCallback } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

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
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">
          {c.name}{' '}
          <span className={`status-pill${c.connected ? ' confirmed' : c.configured ? ' provisional' : ''}`}>
            {c.connected ? 'Connected' : c.configured ? 'Not connected' : 'Not set up'}
          </span>
        </h3>
        <p className="settings-section-sub">{c.description}</p>
      </div>

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
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
