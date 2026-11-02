import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import ConnectionCard from './ConnectionCard.js';

async function errorOf(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export default function ContactsImportCard() {
  const [tokenSet, setTokenSet] = useState<boolean | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/connections/contacts-import', { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(await errorOf(res));
        setTokenSet((await res.json() as { tokenSet: boolean }).tokenSet);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load');
      });
    return () => controller.abort();
  }, []);

  async function makeToken() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/connections/contacts-import-token', { method: 'POST' });
      if (!res.ok) throw new Error(await errorOf(res));
      setNewToken((await res.json() as { token: string }).token);
      setTokenSet(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make a token');
    } finally {
      setBusy(false);
    }
  }

  const muted = { color: 'var(--app-fg-muted)' } as const;
  return (
    <ConnectionCard
      title={<>
        Contacts import token{' '}
        {tokenSet !== null && <span className={`status-pill${tokenSet ? ' confirmed' : ''}`}>{tokenSet ? 'Set' : 'Not set'}</span>}
      </>}
      sub="Lets the Mac mini send contacts it alone can reach (such as Apple Contacts) to Curia. It can do nothing else. Shown once; only its hash is kept."
    >
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        {error && <div style={{ color: 'var(--app-destructive)' }}>{error}</div>}
        <div style={muted}>
          Copy the token straight into the import user&apos;s secrets file on the Mac mini. Making a new one stops the old one working.
          The import route itself is not switched on yet, so this token does nothing until it is.
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
          <button type="button" className="btn btn-secondary" disabled={busy || tokenSet === null} onClick={() => void makeToken()}>
            {tokenSet ? 'Make a new token' : 'Make a token'}
          </button>
        </div>
      </div>
    </ConnectionCard>
  );
}
