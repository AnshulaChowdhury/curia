import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import ConnectionCard from './ConnectionCard.js';

// Mirrors GET /api/connections/inbox-triage (src/channels/http/routes/inbox-triage.ts). The ntfy token is never returned.
interface TriageSettings {
  enabled: boolean;
  ntfyUrl: string;
  hasToken: boolean;
  minConfidence: number | null;
  nylasConfigured: boolean;
  running: boolean;
  accounts: string[];
}

const DEFAULT_CONFIDENCE = '0.6';

async function errorOf(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export default function InboxTriageCard() {
  const [saved, setSaved] = useState<TriageSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [confidence, setConfidence] = useState(DEFAULT_CONFIDENCE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function adopt(s: TriageSettings) {
    setSaved(s);
    setEnabled(s.enabled);
    setUrl(s.ntfyUrl);
    setConfidence(s.minConfidence === null ? DEFAULT_CONFIDENCE : String(s.minConfidence));
    setToken('');
  }

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/connections/inbox-triage', { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(await errorOf(res));
        adopt(await res.json() as TriageSettings);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load' });
      });
    return () => controller.abort();
  }, []);

  async function save(extra: Record<string, unknown> = {}) {
    const parsed = Number(confidence);
    if (!(parsed > 0 && parsed <= 1)) {
      setMessage({ kind: 'error', text: 'Confidence must be above 0 and at most 1.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { enabled, ntfyUrl: url, minConfidence: parsed, ...extra };
      if (token !== '') body['ntfyToken'] = token; // omitted = keep the stored token
      const res = await apiFetch('/api/connections/inbox-triage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      adopt(await res.json() as TriageSettings);
      setMessage({ kind: 'ok', text: 'Saved to the encrypted vault.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(group: 'seen' | 'urgent') {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/connections/inbox-triage/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group }),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      setMessage({
        kind: 'ok',
        text: group === 'urgent'
          ? 'Urgent test push sent. If "Notify for urgent email" is on in Command Hub, an "Urgent email" notification appears.'
          : 'Test push sent. Command Hub refreshes its inbox quietly; it only notifies if "Notify for other new email" is on.',
      });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setBusy(false);
    }
  }

  const status = !saved ? '' : saved.running ? 'Running' : saved.enabled ? 'Not running' : 'Off';
  const dirty = saved !== null && (
    enabled !== saved.enabled || url !== saved.ntfyUrl || token !== '' ||
    confidence !== (saved.minConfidence === null ? DEFAULT_CONFIDENCE : String(saved.minConfidence))
  );

  return (
    <ConnectionCard
      title={<>
        Inbox triage{' '}
        {status && <span className={`status-pill${saved?.running ? ' confirmed' : saved?.enabled ? ' provisional' : ''}`}>{status}</span>}
      </>}
      sub="Sorts new mail into Urgent, Needs reply or FYI within about 30 seconds and pings your phone through ntfy. Values are stored in Curia's encrypted vault; the token is never shown again after saving."
    >
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
        {saved && !saved.nylasConfigured && (
          <div style={{ color: 'var(--app-destructive)' }}>Email is not connected yet (no Nylas key), so there is nothing to triage.</div>
        )}
        {saved?.enabled && saved.nylasConfigured && !saved.running && (
          <div style={{ color: 'var(--app-destructive)' }}>Turned on, but no mailbox is connected for the phone inbox, so the watcher did not start.</div>
        )}
        {saved?.running && (
          <div style={{ color: 'var(--app-fg-muted)' }}>Watching: {saved.accounts.join(', ')}</div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={enabled} disabled={!saved || busy} onChange={e => setEnabled(e.target.checked)} />
          Triage new mail in real time
        </label>
        <div className="form-grid">
          <div className="form-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="triage-url">ntfy topic address</label>
            <input id="triage-url" type="text" placeholder="https://ntfy.example.com/curia-mail" value={url} disabled={!saved || busy}
              onChange={e => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <div className="form-field">
            <label htmlFor="triage-token">Access token (optional)</label>
            <input id="triage-token" type="password" value={token} disabled={!saved || busy} autoComplete="new-password"
              placeholder={saved?.hasToken ? 'Saved. Type to replace.' : 'Only for a protected topic'}
              onChange={e => setToken(e.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="triage-confidence">Minimum confidence</label>
            <input id="triage-confidence" type="text" inputMode="decimal" value={confidence} disabled={!saved || busy}
              onChange={e => setConfidence(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" disabled={!saved || busy || !dirty} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="btn btn-secondary" disabled={!saved || busy || dirty || !saved.ntfyUrl}
            onClick={() => void sendTest('seen')} title={dirty ? 'Save first' : undefined}>
            Send test push
          </button>
          <button type="button" className="btn btn-secondary" disabled={!saved || busy || dirty || !saved.ntfyUrl}
            onClick={() => void sendTest('urgent')} title={dirty ? 'Save first' : undefined}>
            Send urgent test push
          </button>
          {saved?.hasToken && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save({ ntfyToken: '' })}>
              Remove token
            </button>
          )}
          {message && (
            <span style={{ color: message.kind === 'error' ? 'var(--app-destructive)' : 'var(--app-fg-muted)' }}>{message.text}</span>
          )}
        </div>
      </div>
    </ConnectionCard>
  );
}
