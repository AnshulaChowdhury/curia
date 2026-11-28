// accounts-store.ts — what the owner owns and owes, for the budget's net-worth view. Owner-only data.
//
// Bank rows are written by the Plaid sync; manual rows by the owner (a home, a car, anything no bank link shows).
// Totals are computed here so every screen shows the same numbers. Only Canadian-dollar rows with a balance are
// added up: nothing is converted, and what is left out is counted so the screen can say so.

import type { DbPool } from '../db/connection.js';
import { BudgetError } from './budget-store.js';
import { toCents } from './import-parser.js';
import type { PlaidAccount } from './plaid-client.js';

export const ASSET_TYPES = ['cash', 'investment', 'property', 'vehicle', 'other_asset'] as const;
export const DEBT_TYPES = ['credit_card', 'line_of_credit', 'mortgage', 'loan', 'other_debt'] as const;
export type AccountType = (typeof ASSET_TYPES)[number] | (typeof DEBT_TYPES)[number];

export interface BudgetAccount {
  id: string;
  source: 'bank' | 'manual';
  institution: string;
  name: string;
  mask: string | null;
  type: AccountType;
  side: 'asset' | 'debt';
  currency: string;
  balanceCents: number | null;
  asOf: string;
}

export interface NetWorth {
  accounts: BudgetAccount[];
  /** `savingsCents` is the part of the assets that is money: cash (chequing included) and investments. */
  totals: { assetsCents: number; debtsCents: number; netCents: number; savingsCents: number; leftOut: number };
}

/** The largest balance accepted: one trillion dollars, well inside exact integer range. */
const MAX_BALANCE_CENTS = 100_000_000_000_000;

const isDebt = (t: AccountType): boolean => (DEBT_TYPES as readonly string[]).includes(t);
/** Assets that are money put by, as opposed to things owned. */
const SAVINGS_TYPES: readonly AccountType[] = ['cash', 'investment'];
const isType = (v: unknown): v is AccountType => typeof v === 'string' && ((ASSET_TYPES as readonly string[]).includes(v) || isDebt(v as AccountType));

/** Plaid's type and subtype to ours. An unknown kind of account is listed as an "other" asset. */
export function typeForPlaid(type: string | undefined, subtype: string | null | undefined): AccountType {
  const sub = (subtype ?? '').toLowerCase();
  if (sub === 'line of credit' || sub === 'home equity') return 'line_of_credit';
  if (type === 'credit') return 'credit_card';
  if (type === 'loan') return sub === 'mortgage' ? 'mortgage' : 'loan';
  if (type === 'depository') return 'cash';
  if (type === 'investment' || type === 'brokerage') return 'investment';
  return 'other_asset';
}

export function netWorth(accounts: BudgetAccount[]): NetWorth {
  let assetsCents = 0;
  let debtsCents = 0;
  let leftOut = 0;
  let savingsCents = 0;
  for (const a of accounts) {
    if (a.balanceCents === null || a.currency !== 'CAD') leftOut++;
    else if (a.side === 'asset') {
      assetsCents += a.balanceCents;
      if (SAVINGS_TYPES.includes(a.type)) savingsCents += a.balanceCents;
    } else debtsCents += a.balanceCents;
  }
  return { accounts, totals: { assetsCents, debtsCents, netCents: assetsCents - debtsCents, savingsCents, leftOut } };
}

interface Row {
  id: string; link_id: string | null; institution: string; name: string; mask: string | null; type: AccountType;
  currency: string; balance_cents: string | null; as_of: Date;
}
const toAccount = (r: Row): BudgetAccount => ({
  id: r.id, source: r.link_id ? 'bank' : 'manual', institution: r.institution, name: r.name, mask: r.mask, type: r.type,
  side: isDebt(r.type) ? 'debt' : 'asset', currency: r.currency,
  balanceCents: r.balance_cents === null ? null : Number(r.balance_cents), asOf: r.as_of.toISOString(),
});
const COLUMNS = 'id, link_id, institution, name, mask, type, currency, balance_cents, as_of';

export class AccountStore {
  constructor(private readonly pool: DbPool) {}

  async summary(): Promise<NetWorth> {
    const { rows } = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM budget_accounts ORDER BY lower(institution), lower(name), id`);
    return netWorth(rows.map(toAccount));
  }

  async createManual(input: { name?: unknown; type?: unknown; balanceCents?: unknown }): Promise<BudgetAccount> {
    const { name, type, balanceCents } = this.manual(input);
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO budget_accounts (name, type, balance_cents) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`, [name, type, balanceCents]);
    return toAccount(rows[0]!);
  }

  /** Replaces a manual row and stamps it as current. Bank rows cannot be edited: the next sync would undo it. */
  async updateManual(id: string, input: { name?: unknown; type?: unknown; balanceCents?: unknown }): Promise<BudgetAccount> {
    const { name, type, balanceCents } = this.manual(input);
    const { rows } = await this.pool.query<Row>(
      `UPDATE budget_accounts SET name = $2, type = $3, balance_cents = $4, as_of = now() WHERE id = $1 AND link_id IS NULL RETURNING ${COLUMNS}`,
      [id, name, type, balanceCents]);
    if (!rows[0]) throw new BudgetError('No such entry', 'not_found');
    return toAccount(rows[0]);
  }

  async deleteManual(id: string): Promise<void> {
    const res = await this.pool.query('DELETE FROM budget_accounts WHERE id = $1 AND link_id IS NULL', [id]);
    if (res.rowCount === 0) throw new BudgetError('No such entry', 'not_found');
  }

  /** Writes one bank link's current balances and drops accounts the bank no longer reports. */
  async saveBankAccounts(linkId: string, institution: string, accounts: PlaidAccount[]): Promise<void> {
    if (accounts.length === 0) return; // an empty answer is not proof that every account closed
    for (const a of accounts) {
      const current = a.balances?.current;
      await this.pool.query(
        `INSERT INTO budget_accounts (link_id, external_id, institution, name, mask, type, currency, balance_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (external_id) DO UPDATE SET institution = EXCLUDED.institution, name = EXCLUDED.name, mask = EXCLUDED.mask,
           type = EXCLUDED.type, currency = EXCLUDED.currency, balance_cents = EXCLUDED.balance_cents, as_of = now()`,
        [linkId, a.account_id, institution.slice(0, 120), a.name.trim().slice(0, 120) || 'Account', a.mask?.slice(0, 8) || null,
          typeForPlaid(a.type, a.subtype), (a.balances?.iso_currency_code || 'unknown').slice(0, 10),
          typeof current === 'number' && Number.isFinite(current) ? toCents(current.toFixed(2)) : null],
      );
    }
    await this.pool.query('DELETE FROM budget_accounts WHERE link_id = $1 AND NOT (external_id = ANY($2::text[]))', [linkId, accounts.map(a => a.account_id)]);
  }

  private manual(input: { name?: unknown; type?: unknown; balanceCents?: unknown }): { name: string; type: AccountType; balanceCents: number } {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
    if (!name) throw new BudgetError('Give it a name');
    if (!isType(input.type)) throw new BudgetError('Choose what kind of asset or debt it is');
    const cents = input.balanceCents;
    if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0 || cents > MAX_BALANCE_CENTS) {
      throw new BudgetError('balanceCents must be a whole number of cents, zero or more');
    }
    return { name, type: input.type, balanceCents: cents };
  }
}
