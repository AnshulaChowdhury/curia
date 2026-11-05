// preference-store.ts — what the owner has told triage about a sender or a domain (table inbox_triage_preferences).
//
// A preference is only ever created by the owner saying yes on the phone. The classifier reads it as a hint ("you
// filed this sender as Needs a reply before"); it is evidence for the model, not a rule that skips it.

import type { DbPool } from '../db/connection.js';
import { TRIAGE_GROUPS, type TriageGroup } from './types.js';

export type PreferenceScope = 'sender' | 'domain';

export interface TriagePreference {
  accountId: string;
  scope: PreferenceScope;
  value: string;
  group: TriageGroup;
}

/** Mailbox providers many unrelated people share: a "whole domain" preference for one of these would be wrong. */
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'fastmail.com', 'hey.com',
]);

const ADDRESS = /^[^\s@<>"',;]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export const isTriageGroup = (value: unknown): value is TriageGroup =>
  typeof value === 'string' && (TRIAGE_GROUPS as readonly string[]).includes(value);

/** The lower-case address and its domain, or null when this is not a plain address. */
export function addressParts(raw: string): { address: string; domain: string } | null {
  const address = raw.trim().toLowerCase();
  if (address.length > 254) return null;
  const match = ADDRESS.exec(address);
  return match?.[1] ? { address, domain: match[1] } : null;
}

export const isSharedMailDomain = (domain: string): boolean => SHARED_MAIL_DOMAINS.has(domain.toLowerCase());

/** True when `value` is acceptable for `scope`: a plain address, or a domain that is not a shared mail provider. */
export function validPreferenceValue(scope: PreferenceScope, value: string): boolean {
  if (scope === 'sender') return addressParts(value)?.address === value;
  return value.length <= 253 && DOMAIN.test(value) && !isSharedMailDomain(value);
}

export class PgPreferenceStore {
  constructor(private readonly pool: DbPool) {}

  /** The owner's choice for this sender (an exact address beats its domain), or null. */
  async lookup(accountId: string, fromAddress: string): Promise<TriageGroup | null> {
    const parts = addressParts(fromAddress);
    if (!parts) return null;
    const result = await this.pool.query<{ scope: PreferenceScope; group_name: string }>(
      `SELECT scope, group_name FROM inbox_triage_preferences
       WHERE account_id = $1 AND ((scope = 'sender' AND value = $2) OR (scope = 'domain' AND value = $3))`,
      [accountId, parts.address, parts.domain],
    );
    const pick = result.rows.find((r) => r.scope === 'sender') ?? result.rows.find((r) => r.scope === 'domain');
    return pick && isTriageGroup(pick.group_name) ? pick.group_name : null;
  }

  async save(p: TriagePreference): Promise<void> {
    await this.pool.query(
      `INSERT INTO inbox_triage_preferences (account_id, scope, value, group_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, scope, value) DO UPDATE SET group_name = EXCLUDED.group_name, updated_at = now()`,
      [p.accountId, p.scope, p.value, p.group],
    );
  }

  async list(): Promise<TriagePreference[]> {
    const result = await this.pool.query<{ account_id: string; scope: PreferenceScope; value: string; group_name: string }>(
      `SELECT account_id, scope, value, group_name FROM inbox_triage_preferences ORDER BY account_id, scope, value LIMIT 500`,
    );
    return result.rows.flatMap((r) => (isTriageGroup(r.group_name)
      ? [{ accountId: r.account_id, scope: r.scope, value: r.value, group: r.group_name }]
      : []));
  }

  /** True if it existed. */
  async remove(accountId: string, scope: PreferenceScope, value: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM inbox_triage_preferences WHERE account_id = $1 AND scope = $2 AND value = $3`,
      [accountId, scope, value],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
