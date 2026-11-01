import { useState, useEffect } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// Mirrors GET /api/connections (src/channels/http/routes/quickbooks.ts). No tokens are ever returned.
interface Connection {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  connected: boolean;
  environment?: string;
  realmId?: string;
  connectedAt?: string;
  refreshExpiresAt?: string;
  connectUrl: string;
}

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

export default function ConnectionsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/connections', { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { connections: Connection[] };
        setConnections(data.connections ?? []);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load');
      });
    return () => controller.abort();
  }, []);

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
                Outside services Curia is authorised to use. Curia keeps the tokens encrypted and refreshes them; they are never shown here.
              </p>
            </div>
            {loadError && <div style={{ color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>}
            {connections.map(c => (
              <section key={c.id} className="settings-section">
                <div className="settings-section-head">
                  <h3 className="settings-section-title">
                    {c.name}{' '}
                    <span className={`status-pill${c.connected ? ' confirmed' : c.configured ? ' provisional' : ''}`}>
                      {c.connected ? 'Connected' : c.configured ? 'Not connected' : 'Not set up'}
                    </span>
                  </h3>
                  <p className="settings-section-sub">{c.description}</p>
                </div>
                <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                  {c.connected ? (
                    <div style={{ color: 'var(--app-fg-muted)' }}>
                      {c.environment} company {c.realmId}, connected {formatDate(c.connectedAt)}. Authorisation good until{' '}
                      {formatDate(c.refreshExpiresAt)} (it renews each time the books run).
                    </div>
                  ) : c.configured ? (
                    <div style={{ color: 'var(--app-fg-muted)' }}>Sign in to Intuit as an admin of the company to authorise Curia.</div>
                  ) : (
                    <div style={{ color: 'var(--app-fg-muted)' }}>
                      Set QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI on the Curia service first.
                    </div>
                  )}
                  {c.configured && (
                    <div>
                      <a className={`btn ${c.connected ? 'btn-secondary' : 'btn-primary'}`} href={c.connectUrl}>
                        {c.connected ? 'Reconnect' : 'Connect'}
                      </a>
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
