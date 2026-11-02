import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import ConnectionCard from './ConnectionCard.js';

// Mirrors GET /api/connections/matrix-bridges (src/channels/http/routes/contacts-connections.ts).
// A bridge's secret is never returned: only whether one is saved.
interface Bridge {
  id: string;
  label: string;
  url: string;
  suggestedUrl: string;
  hasSecret: boolean;
}

// Mirrors POST .../test. Counts only: the server never returns a name, number or id.
interface TestResult {
  ok: boolean;
  message: string;
  network?: string;
  loginState?: string;
  contacts?: number;
  withPhone?: number;
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function BridgeRow({ initial }: { initial: Bridge }) {
  const [saved, setSaved] = useState(initial);
  const [url, setUrl] = useState(initial.url);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const dirty = url.trim() !== saved.url || secret !== '';

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch(`/api/connections/matrix-bridges/${saved.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      const next = await res.json() as Bridge;
      setSaved(next);
      setUrl(next.url);
      setSecret('');
      setMessage({ kind: 'ok', text: 'Saved to the encrypted vault.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch(`/api/connections/matrix-bridges/${saved.id}/test`, { method: 'POST' });
      if (!res.ok) throw new Error(await errorOf(res));
      const r = await res.json() as TestResult;
      const counts = r.ok ? ` ${r.contacts ?? 0} contacts, ${r.withPhone ?? 0} with a phone number.` : '';
      setMessage({ kind: r.ok ? 'ok' : 'error', text: `${r.message}${counts}` });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--app-border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontWeight: 600 }}>
        {saved.label}{' '}
        <span className={`status-pill${saved.url && saved.hasSecret ? ' confirmed' : saved.url || saved.hasSecret ? ' provisional' : ''}`}>
          {saved.url && saved.hasSecret ? 'Saved' : saved.url || saved.hasSecret ? 'Incomplete' : 'Not set up'}
        </span>
      </div>
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor={`bridge-url-${saved.id}`}>Address (private network)</label>
          <input id={`bridge-url-${saved.id}`} type="text" value={url} placeholder={saved.suggestedUrl} disabled={busy}
            onChange={e => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="form-field">
          <label htmlFor={`bridge-secret-${saved.id}`}>Provisioning secret</label>
          <input id={`bridge-secret-${saved.id}`} type="password" value={secret} disabled={busy} autoComplete="new-password"
            placeholder={saved.hasSecret ? 'Saved. Type to replace.' : 'From the bridge service in Railway'}
            onChange={e => setSecret(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={busy || !dirty}
          onClick={() => void save({ url: url.trim(), ...(secret !== '' ? { secret } : {}) })}>
          Save
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy || dirty || !saved.url || !saved.hasSecret}
          onClick={() => void test()} title={dirty ? 'Save first' : undefined}>
          Test connection
        </button>
        {saved.hasSecret && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save({ secret: '' })}>
            Remove secret
          </button>
        )}
        {message && (
          <span style={{ color: message.kind === 'error' ? 'var(--app-destructive)' : 'var(--app-fg-muted)' }}>{message.text}</span>
        )}
      </div>
    </div>
  );
}

export default function MatrixBridgesCard() {
  const [bridges, setBridges] = useState<Bridge[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/connections/matrix-bridges', { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(await errorOf(res));
        setBridges((await res.json() as { bridges: Bridge[] }).bridges);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load');
      });
    return () => controller.abort();
  }, []);

  return (
    <ConnectionCard
      title="Matrix bridges (contacts)"
      sub="Where Curia reads each messaging bridge's contact list, read-only, to find new people. Curia never signs in to Matrix and never sees messages. Addresses must be on the private network; secrets are stored in the encrypted vault and never shown again."
    >
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
        {loadError && <div style={{ color: 'var(--app-destructive)' }}>{loadError}</div>}
        {bridges?.map(b => <BridgeRow key={b.id} initial={b} />)}
      </div>
    </ConnectionCard>
  );
}
