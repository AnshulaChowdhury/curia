// preference-store.ts — what the owner has told triage about a sender or a domain (table inbox_triage_preferences).
//
// A preference is only ever created by the owner saying yes on the phone. The classifier reads it as a hint ("you
// filed this sender as Needs a reply before"); it is evidence for the model, not a rule that skips it.

import type { DbPool } from '../db/connection.js';
import { keywordsMatch, keywordHits } from './keywords.js';
import { TRIAGE_GROUPS, type TriageGroup } from './types.js';

export type PreferenceScope = 'sender' | 'domain' | 'sender-keywords';

export interface TriagePreference {
  accountId: string;
  scope: PreferenceScope;
  value: string;
  group: TriageGroup;
  /** Only for scope 'sender-keywords': 1 to 5 sorted, lower-case words. Empty otherwise. */
  keywords: string[];
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
  if (scope === 'sender' || scope === 'sender-keywords') return addressParts(value)?.address === value;
  return value.length <= 253 && DOMAIN.test(value) && !isSharedMailDomain(value);
}

/** What the classifier knows about the email being asked about, for matching keyword rules. */
export interface PreferenceContext {
  subject: string;
  preview: string;
}

interface Row { account_id: string; scope: PreferenceScope; value: string; group_name: string; keywords: string[] }

export class PgPreferenceStore {
  constructor(private readonly pool: DbPool) {}

  /**
   * The owner's choice for this sender, or null. A keyword rule that matches this email wins (the one with the most
   * matching words first), then the exact sender, then its domain.
   */
  async lookup(accountId: string, fromAddress: string, context?: PreferenceContext): Promise<TriageGroup | null> {
    const parts = addressParts(fromAddress);
    if (!parts) return null;
    const result = await this.pool.query<Row>(
      `SELECT account_id, scope, value, group_name, keywords FROM inbox_triage_preferences
       WHERE account_id = $1 AND ((scope IN ('sender', 'sender-keywords') AND value = $2) OR (scope = 'domain' AND value = $3))`,
      [accountId, parts.address, parts.domain],
    );
    if (context) {
      const matched = result.rows
        .filter((r) => r.scope === 'sender-keywords' && isTriageGroup(r.group_name) && keywordsMatch(r.keywords, context.subject, context.preview))
        .sort((a, b) => keywordHits(b.keywords, context.subject, context.preview) - keywordHits(a.keywords, context.subject, context.preview));
      const best = matched[0];
      if (best && isTriageGroup(best.group_name)) return best.group_name;
    }
    const pick = result.rows.find((r) => r.scope === 'sender') ?? result.rows.find((r) => r.scope === 'domain');
    return pick && isTriageGroup(pick.group_name) ? pick.group_name : null;
  }

  async save(p: Omit<TriagePreference, 'keywords'> & { keywords?: string[] }): Promise<void> {
    await this.pool.query(
      `INSERT INTO inbox_triage_preferences (account_id, scope, value, group_name, keywords) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, scope, value, keywords) DO UPDATE SET group_name = EXCLUDED.group_name, updated_at = now()`,
      [p.accountId, p.scope, p.value, p.group, p.scope === 'sender-keywords' ? (p.keywords ?? []) : []],
    );
  }

  async list(): Promise<TriagePreference[]> {
    const result = await this.pool.query<Row>(
      `SELECT account_id, scope, value, group_name, keywords FROM inbox_triage_preferences ORDER BY account_id, scope, value, keywords LIMIT 500`,
    );
    return result.rows.flatMap((r) => (isTriageGroup(r.group_name)
      ? [{ accountId: r.account_id, scope: r.scope, value: r.value, group: r.group_name, keywords: r.keywords ?? [] }]
      : []));
  }

  /** True if it existed. `keywords` identify a keyword rule (the sender alone is not enough). */
  async remove(accountId: string, scope: PreferenceScope, value: string, keywords: string[] = []): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM inbox_triage_preferences WHERE account_id = $1 AND scope = $2 AND value = $3 AND keywords = $4`,
      [accountId, scope, value, scope === 'sender-keywords' ? keywords : []],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
