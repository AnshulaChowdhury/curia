// bank-account-history.ts — recognising a bank account that is, or was, already in the budget.
//
// Plaid gives the same real account a new account_id on every connection, so two logins to a joint account, or a bank
// that is disconnected and added again, would otherwise import its transactions twice. An account is recognised by its
// institution, kind, subtype and last digits. An account with no last digits cannot be recognised.

import type { DbPool } from '../db/connection.js';
import { typeForPlaid } from './accounts-store.js';
import type { PlaidAccount } from './plaid-client.js';

export interface AccountIdentity { institution: string; mask: string | null; kind: string; subtype: string | null }

export interface KnownAccount extends AccountIdentity {
  externalId: string;
  label: string;
  labelPinned: boolean;
  blocked: boolean;
  /** YYYY-MM-DD. Set on a re-added account: nothing dated earlier is imported. */
  importAfter: string | null;
  seenThatDay: number[];
}

export function identityOf(institution: string, a: PlaidAccount): AccountIdentity {
  return { institution, mask: a.mask?.slice(0, 8) || null, kind: typeForPlaid(a.type, a.subtype), subtype: a.subtype?.toLowerCase() || null };
}

export function sameAccount(a: AccountIdentity, b: AccountIdentity): boolean {
  return a.mask !== null && a.mask === b.mask && a.kind === b.kind
    && a.institution.trim().toLowerCase() === b.institution.trim().toLowerCase()
    && (a.subtype === null || b.subtype === null || a.subtype === b.subtype);
}

export function accountLabelFor(institution: string, a: PlaidAccount): string {
  return `${institution} ${a.name}${a.mask ? ` ••${a.mask}` : ''}`.slice(0, 60);
}

interface Row {
  external_id: string; institution: string; mask: string | null; kind: string; subtype: string | null; label: string;
  label_pinned: boolean; blocked: boolean; import_after: string | null; seen_that_day: number[];
}
const COLUMNS = `external_id, institution, mask, kind, subtype, label, label_pinned, blocked,
  to_char(import_after, 'YYYY-MM-DD') AS import_after, seen_that_day`;
const toKnown = (r: Row): KnownAccount => ({
  externalId: r.external_id, institution: r.institution, mask: r.mask, kind: r.kind, subtype: r.subtype, label: r.label,
  labelPinned: r.label_pinned, blocked: r.blocked, importAfter: r.import_after, seenThatDay: r.seen_that_day,
});

export class BankAccountHistory {
  constructor(private readonly pool: DbPool) {}

  async forLink(linkId: string): Promise<Map<string, KnownAccount>> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM budget_bank_account_history WHERE link_id = $1`, [linkId]);
    return new Map(rows.map(r => [r.external_id, toKnown(r)]));
  }

  /** The accounts being imported through any connection other than `exceptLinkId`. */
  async connected(exceptLinkId: string | null): Promise<KnownAccount[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM budget_bank_account_history WHERE link_id IS NOT NULL AND NOT blocked AND link_id IS DISTINCT FROM $1`, [exceptLinkId]);
    return rows.map(toKnown);
  }

  /**
   * Records an account this connection has not reported before. It is blocked if another connection already imports it.
   * `alreadyImported` is for an account this connection was importing before its history was kept: never blocked.
   */
  async register(linkId: string, institution: string, account: PlaidAccount, alreadyImported = false): Promise<KnownAccount> {
    const identity = identityOf(institution, account);
    const blocked = !alreadyImported && (await this.connected(linkId)).some(k => sameAccount(k, identity));
    let label = accountLabelFor(institution, account);
    let labelPinned = false;
    let importAfter: string | null = null;
    let seenThatDay: number[] = [];

    if (!blocked && !alreadyImported) {
      const { rows } = await this.pool.query<Row>(
        `SELECT ${COLUMNS} FROM budget_bank_account_history WHERE link_id IS NULL ORDER BY created_at DESC`);
      const earlier = rows.map(toKnown).filter(k => sameAccount(k, identity));
      if (earlier.length > 0) {
        label = earlier[0]!.label;
        labelPinned = true;
        const stored = await this.pool.query<{ day: string; amounts: number[] }>(
          `SELECT to_char(txn_date, 'YYYY-MM-DD') AS day, array_agg(amount_cents) AS amounts FROM budget_transactions
           WHERE account = $1 GROUP BY txn_date ORDER BY txn_date DESC LIMIT 1`, [label]);
        importAfter = stored.rows[0]?.day ?? null;
        seenThatDay = stored.rows[0]?.amounts ?? [];
        // Only the record taken over: a second account with the same details keeps its own.
        await this.pool.query('DELETE FROM budget_bank_account_history WHERE external_id = $1', [earlier[0]!.externalId]);
      }
    }

    await this.pool.query(
      `INSERT INTO budget_bank_account_history
         (external_id, link_id, institution, mask, kind, subtype, label, label_pinned, blocked, import_after, seen_that_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (external_id) DO UPDATE SET link_id = EXCLUDED.link_id, blocked = EXCLUDED.blocked`,
      [account.account_id, linkId, institution.slice(0, 120), identity.mask, identity.kind, identity.subtype, label, labelPinned, blocked, importAfter, seenThatDay]);
    return { ...identity, externalId: account.account_id, label, labelPinned, blocked, importAfter, seenThatDay };
  }

  /** Saves what a sync learnt: the account's current name and which amounts on the cut-off day are still to be skipped. */
  async save(account: KnownAccount): Promise<void> {
    await this.pool.query('UPDATE budget_bank_account_history SET label = $2, subtype = $3, seen_that_day = $4 WHERE external_id = $1',
      [account.externalId, account.label, account.subtype, account.seenThatDay]);
  }

  /** Before a connection is removed: accounts it never imported are forgotten; the others are kept for next time. */
  async forgetBlocked(linkId: string): Promise<void> {
    await this.pool.query('DELETE FROM budget_bank_account_history WHERE link_id = $1 AND blocked', [linkId]);
  }
}

/**
 * Whether a transaction on a re-added account is new. Anything before the cut-off day is already stored. On that day,
 * each amount already stored is skipped once, so a later purchase that day still arrives.
 */
export function isNewSinceReconnect(account: KnownAccount, date: string, amountCents: number): boolean {
  if (account.importAfter === null || date > account.importAfter) return true;
  if (date < account.importAfter) return false;
  const at = account.seenThatDay.indexOf(amountCents);
  if (at === -1) return true;
  account.seenThatDay.splice(at, 1);
  return false;
}
