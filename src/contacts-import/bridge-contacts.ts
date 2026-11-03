// bridge-contacts.ts — reads one Matrix bridge's contact list (read-only) and turns it into candidates for the import.
//
// Same provisioning calls as the Test button (whoami, then the logged-in account's contacts), but this one returns the
// people. It is only ever called for the import's preview; its result is never logged, and failures say only what kind
// of failure it was (the error text can carry the bridge address).

import type { Logger } from '../logger.js';
import { normalizePhone } from './normalize.js';
import type { Candidate } from './merge.js';

const BRIDGE_USER = '@anshula:mautrix';
const TIMEOUT_MS = 60_000;
export const MAX_BRIDGE_CONTACTS = 20_000;

export interface BridgeContactsResult {
  ok: boolean;
  /** Fixed, content-free text safe to show in the console. */
  message: string;
  /** How many entries the bridge returned (before dropping any that have no number or no name). */
  read: number;
  candidates: Candidate[];
}

interface WhoAmI { logins?: Array<{ id?: unknown }> }
interface ContactsBody { contacts?: Array<{ id?: unknown; name?: unknown; identifiers?: unknown }> }

export async function fetchBridgeContacts(
  bridge: { id: string; label: string },
  url: string,
  secret: string,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeContactsResult> {
  const fail = (message: string): BridgeContactsResult => ({ ok: false, message, read: 0, candidates: [] });
  const base = url.replace(/\/+$/, '') + '/_matrix/provision/v3';
  const headers = { Authorization: `Bearer ${secret}`, Accept: 'application/json' };
  const call = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON: handled as an unexpected answer below.
    }
    return { status: res.status, body };
  };

  try {
    const who = await call(`/whoami?user_id=${encodeURIComponent(BRIDGE_USER)}`);
    if (who.status === 401 || who.status === 403) return fail(`The bridge refused the secret (HTTP ${who.status}).`);
    if (who.status !== 200 || typeof who.body !== 'object' || who.body === null) return fail(`The bridge answered HTTP ${who.status} to whoami.`);
    const login = ((who.body as WhoAmI).logins ?? []).find((l) => typeof l.id === 'string');
    if (!login || typeof login.id !== 'string') return fail('Nobody is logged in to this bridge yet.');

    const res = await call(`/contacts?login_id=${encodeURIComponent(login.id)}&user_id=${encodeURIComponent(BRIDGE_USER)}`);
    const contacts = (res.body as ContactsBody | null)?.contacts;
    if (res.status !== 200 || !Array.isArray(contacts)) return fail(`The bridge answered HTTP ${res.status} to the contact list.`);
    if (contacts.length > MAX_BRIDGE_CONTACTS) return fail('The bridge returned more contacts than expected; nothing was read.');

    const candidates: Candidate[] = [];
    for (const c of contacts) {
      if (typeof c.id !== 'string' || typeof c.name !== 'string') continue;
      const ids = Array.isArray(c.identifiers) ? c.identifiers : [];
      const phones = [...new Set(ids.filter((i): i is string => typeof i === 'string' && i.startsWith('tel:'))
        .map(normalizePhone).filter((p): p is string => p !== null))];
      if (phones.length === 0) continue; // nothing to match on; the import never guesses
      candidates.push({ sourceKey: `bridge:${bridge.id}:${c.id}`, sourceId: `bridge:${bridge.id}`, displayName: c.name, emails: [], phones });
    }
    return { ok: true, message: 'Read.', read: contacts.length, candidates };
  } catch (err) {
    logger.warn({ bridge: bridge.id, errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-import: could not read a bridge');
    return fail('Could not reach the bridge (timed out or connection refused).');
  }
}
