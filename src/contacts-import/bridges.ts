// bridges.ts — the Matrix bridges Curia reads contact lists from (read-only), and how their connection details are
// stored. Every vault name here is fixed in code: the connections routes can only write names derived from BRIDGES,
// never an arbitrary key.
//
// The bridges (mautrix) have no public domain. Curia reaches them on the Railway private network, so a bridge address
// must be a private one (see isPrivateBridgeHost). The provisioning secret is sent to that address as a bearer token,
// and nothing this module returns or logs contains a contact's name, number or id: only counts.

import type { Logger } from '../logger.js';

export const BRIDGES = [
  { id: 'whatsapp', label: 'WhatsApp', service: 'mautrix-whatsapp', port: 29318 },
  { id: 'gmessages', label: 'Google Messages (SMS/RCS)', service: 'mautrix-gmessages', port: 29336 },
  { id: 'signal', label: 'Signal', service: 'mautrix-signal', port: 29328 },
  { id: 'instagram', label: 'Instagram', service: 'mautrix-instagram', port: 29330 },
] as const;

export type BridgeId = (typeof BRIDGES)[number]['id'];

export function findBridge(id: string): (typeof BRIDGES)[number] | undefined {
  return BRIDGES.find(b => b.id === id);
}

export const bridgeVaultKeys = (id: BridgeId): { url: string; secret: string } => ({
  url: `matrix_bridge_${id}_url`,
  secret: `matrix_bridge_${id}_secret`,
});

/** The address Curia would use inside the Railway environment, offered as the form's placeholder. */
export function suggestedBridgeUrl(bridge: (typeof BRIDGES)[number]): string {
  return `http://${bridge.service}.railway.internal:${bridge.port}`;
}

const MAX_URL = 300;
const MAX_SECRET = 512;
export { MAX_SECRET as MAX_BRIDGE_SECRET };

/**
 * True for hosts that are not on the public internet: `*.railway.internal`, localhost, loopback and private IPv4
 * ranges. The bridges must never be given a public domain, and the provisioning secret must never be sent to one.
 */
export function isPrivateBridgeHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.railway.internal')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some(p => Number(p) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Why an address is unacceptable, or null if it is fine. Messages are safe to show in the console. */
export function bridgeUrlProblem(value: string): string | null {
  if (value.length > MAX_URL) return 'address is too long';
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'address is not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'address must start with http:// or https://';
  if (u.username || u.password) return 'address must not contain a username or password';
  if (u.search || u.hash) return 'address must not contain a query or fragment';
  if (!isPrivateBridgeHost(u.hostname)) {
    return 'address must be on the private network (for example http://mautrix-signal.railway.internal:29328); bridges must never have a public address';
  }
  return null;
}

export interface BridgeTestResult {
  ok: boolean;
  /** Fixed, content-free text safe to show to the user. */
  message: string;
  network?: string;
  loginState?: string;
  contacts?: number;
  withPhone?: number;
}

// The user the bridges were configured for (see infra/matrix: permissions "@anshula:mautrix": admin).
const BRIDGE_USER = '@anshula:mautrix';
const TIMEOUT_MS = 20_000;

interface WhoAmI {
  network?: { network_id?: unknown };
  logins?: Array<{ id?: unknown; state_event?: unknown }>;
}
interface ContactsBody {
  contacts?: Array<{ identifiers?: unknown }>;
}

/**
 * Checks one bridge: who is logged in, then counts that login's contacts. Read-only. Returns counts only; never a
 * name, number, id, secret or response body.
 */
export async function testBridge(
  url: string,
  secret: string,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeTestResult> {
  const base = url.replace(/\/+$/, '') + '/_matrix/provision/v3';
  const headers = { Authorization: `Bearer ${secret}`, Accept: 'application/json' };
  const call = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON: treated as an unexpected answer by the caller.
    }
    return { status: res.status, body };
  };

  try {
    const who = await call(`/whoami?user_id=${encodeURIComponent(BRIDGE_USER)}`);
    if (who.status === 401 || who.status === 403) return { ok: false, message: 'The bridge refused the secret (HTTP ' + who.status + ').' };
    if (who.status !== 200 || typeof who.body !== 'object' || who.body === null) {
      return { ok: false, message: `The bridge answered HTTP ${who.status} to whoami.` };
    }
    const w = who.body as WhoAmI;
    const network = typeof w.network?.network_id === 'string' ? w.network.network_id : undefined;
    const logins = Array.isArray(w.logins) ? w.logins : [];
    const login = logins.find(l => typeof l.id === 'string');
    if (!login || typeof login.id !== 'string') {
      return { ok: false, message: 'Reached the bridge, but nobody is logged in to it yet.', ...(network ? { network } : {}), loginState: 'none' };
    }
    const loginState = typeof login.state_event === 'string' ? login.state_event : 'unknown';

    const res = await call(`/contacts?login_id=${encodeURIComponent(login.id)}&user_id=${encodeURIComponent(BRIDGE_USER)}`);
    if (res.status !== 200 || typeof res.body !== 'object' || res.body === null) {
      return { ok: false, message: `The bridge answered HTTP ${res.status} to the contact list.`, ...(network ? { network } : {}), loginState };
    }
    const contacts = (res.body as ContactsBody).contacts;
    if (!Array.isArray(contacts)) {
      return { ok: false, message: 'The bridge answered, but not with a contact list.', ...(network ? { network } : {}), loginState };
    }
    const withPhone = contacts.filter(c =>
      Array.isArray(c.identifiers) && c.identifiers.some(i => typeof i === 'string' && i.startsWith('tel:'))).length;
    return {
      ok: true,
      message: 'Connected.',
      ...(network ? { network } : {}),
      loginState,
      contacts: contacts.length,
      withPhone,
    };
  } catch (err) {
    // The error can carry the address; log only its kind.
    logger.warn({ errorName: err instanceof Error ? err.name : 'unknown' }, 'matrix-bridge test: request failed');
    return { ok: false, message: 'Could not reach the bridge (timed out or connection refused). Check the address.' };
  }
}
