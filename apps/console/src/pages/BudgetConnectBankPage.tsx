import { useState } from 'react';
import { BudgetShell } from './BudgetShell.js';
import { runPlaidLink, runPlaidReconnect, BudgetApiError } from './budget-banks.js';

const RETURN_PATH = '/budget';

/**
 * Connect a bank with Plaid Link, or, with `?link=<id>`, log in to an existing connection's bank again. The server gives
 * only this exact path a CSP that allows cdn.plaid.com, and a CSP is fixed when the document loads. So this page is
 * reached by a full page load (a plain link, not router navigation) and returns the same way. The Plaid script is added
 * at runtime; there is no inline script.
 */
export default function BudgetConnectBankPage() {
  const reconnectId = new URLSearchParams(window.location.search).get('link');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Accounts left out as already connected: shown here, so it is read before leaving the page. */
  const [notice, setNotice] = useState<string | null>(null);

  async function start() {
    setBusy(true); setError(null);
    try {
      if (reconnectId) {
        if (await runPlaidReconnect(reconnectId)) { window.location.assign(RETURN_PATH); return; }
      } else {
        const result = await runPlaidLink();
        if (result?.notice) setNotice(result.notice);
        else if (result) { window.location.assign(RETURN_PATH); return; }
      }
    } catch (e) {
      setError(e instanceof BudgetApiError && e.locked ? 'Budget data is private to the owner.' : e instanceof Error ? e.message : 'Could not start Plaid.');
    }
    setBusy(false);
  }

  return (
    <BudgetShell active="/budget">
      <section className="dash-card bud-narrow">
        <h3 className="dash-card-title">{reconnectId ? 'Reconnect a bank' : 'Connect a bank'}</h3>
        <p className="bud-hint">Plaid opens a secure window. Your bank login goes to your bank through Plaid and never reaches this app.</p>
        {error && <p className="bud-error" role="alert">{error}</p>}
        {notice && <p className="bud-hint" role="status">{notice}</p>}
        <div className="bud-row">
          {!notice && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void start()}>{busy ? 'Opening…' : 'Open Plaid'}</button>}
          <a className="btn btn-secondary btn-sm" href={RETURN_PATH}>Back</a>
        </div>
      </section>
    </BudgetShell>
  );
}
