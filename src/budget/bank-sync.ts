// bank-sync.ts — the bank links (Plaid) behind the personal budget, and the job that pulls their new transactions.
//
// The Plaid access token never leaves the vault (plaid_access_<link id>) and is never returned by any route. Only
// settled transactions are imported: a pending one gets a new id when it settles, which would count it twice.
// Plaid reports money out as positive; the budget stores it negative.

import type { Logger } from '../logger.js';
import type { DbPool } from '../db/connection.js';
import type { NewTransaction } from './budget-store.js';
import { PlaidError, type PlaidAccount, type PlaidClient, type PlaidTransaction } from './plaid-client.js';
import { toCents } from './import-parser.js';

export interface BankLink {
  id: string; institution: string; status: 'active' | 'needs_login' | 'error'; lastError: string | null;
  lastSyncedAt: string | null; accounts: string[];
}

interface Secrets { get(name: string): Promise<string | null>; set(name: string, value: string): Promise<void>; delete(name: string): Promise<void> }
interface Ingest { addTransactions(items: NewTransaction[]): Promise<{ added: number; duplicates: number }> }
interface Balances { saveBankAccounts(linkId: string, institution: string, accounts: PlaidAccount[]): Promise<void> }
interface Row { id: string; institution: string; plaid_item_id: string; cursor: string | null; accounts: Record<string, string>; status: BankLink['status']; last_error: string | null; last_synced_at: Date | null }

const TOKEN = (id: string) => `plaid_access_${id}`;
const MAX_PAGES = 20;

export function toNewTransaction(t: PlaidTransaction, account: string): NewTransaction | null {
  if (t.pending || (t.iso_currency_code && t.iso_currency_code !== 'CAD')) return null;
  const cents = toCents(t.amount.toFixed(2));
  if (cents === null || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return null;
  return { account, date: t.date, payee: t.merchant_name || t.name, description: t.merchant_name ? t.name : '', amountCents: cents === 0 ? 0 : -cents, externalId: t.transaction_id };
}

export class BankSync {
  constructor(private readonly deps: { pool: DbPool; plaid: PlaidClient; secrets: Secrets; budget: Ingest; balances: Balances; logger: Logger }) {}

  private shape(r: Row): BankLink {
    return { id: r.id, institution: r.institution, status: r.status, lastError: r.last_error, lastSyncedAt: r.last_synced_at?.toISOString() ?? null, accounts: Object.values(r.accounts) };
  }

  async list(): Promise<BankLink[]> {
    const { rows } = await this.deps.pool.query<Row>('SELECT * FROM budget_bank_links ORDER BY created_at');
    return rows.map(r => this.shape(r));
  }

  /** Exchanges the browser's public token, stores the access token in the vault, and runs the first sync. */
  async connect(publicToken: string, institution: string): Promise<BankLink> {
    const { accessToken, itemId } = await this.deps.plaid.exchangePublicToken(publicToken);
    const inst = institution.trim().slice(0, 120) || 'Bank';
    const ins = await this.deps.pool.query<Row>(
      `INSERT INTO budget_bank_links (institution, plaid_item_id) VALUES ($1, $2)
       ON CONFLICT (plaid_item_id) DO UPDATE SET status = 'active', last_error = NULL RETURNING *`, [inst, itemId]);
    const row = ins.rows[0]!;
    await this.deps.secrets.set(TOKEN(row.id), accessToken);
    await this.syncOne(row.id);
    return this.shape((await this.deps.pool.query<Row>('SELECT * FROM budget_bank_links WHERE id = $1', [row.id])).rows[0]!);
  }

  /** Pulls everything new for one link. Returns how many transactions were added. */
  async syncOne(id: string): Promise<number> {
    const { pool, plaid, secrets, budget, logger } = this.deps;
    const row = (await pool.query<Row>('SELECT * FROM budget_bank_links WHERE id = $1', [id])).rows[0];
    const token = await secrets.get(TOKEN(id));
    if (!row || !token) throw new PlaidError('That bank link has no stored credentials', 'NO_TOKEN', 404);
    let cursor = row.cursor;
    const labels = { ...row.accounts };
    let added = 0;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await plaid.sync(token, cursor);
        for (const a of res.accounts) labels[a.account_id] = `${row.institution} ${a.name}${a.mask ? ` ••${a.mask}` : ''}`.slice(0, 60);
        const items = res.added.map(t => toNewTransaction(t, labels[t.account_id] ?? row.institution)).filter((t): t is NewTransaction => t !== null);
        added += (await budget.addTransactions(items)).added;
        cursor = res.next_cursor;
        // The cursor is saved after each page's rows are stored, so a failure resumes without losing or repeating pages.
        await pool.query('UPDATE budget_bank_links SET cursor = $2, accounts = $3 WHERE id = $1', [id, cursor, JSON.stringify(labels)]);
        if (!res.has_more) break;
      }
      // Balances are a separate call. Its failure is logged and leaves the last ones in place: the transactions are in.
      try {
        await this.deps.balances.saveBankAccounts(id, row.institution, await plaid.accounts(token));
      } catch (err) {
        logger.warn({ linkId: id, code: err instanceof PlaidError ? err.code : undefined, err: err instanceof PlaidError ? undefined : err }, 'budget: balance refresh failed');
      }
      await pool.query(`UPDATE budget_bank_links SET status = 'active', last_error = NULL, last_synced_at = now() WHERE id = $1`, [id]);
      return added;
    } catch (err) {
      const needsLogin = err instanceof PlaidError && err.needsLogin;
      const msg = (err instanceof PlaidError ? `${err.code}: ${err.message}` : 'Sync failed').slice(0, 300);
      logger.warn({ linkId: id, code: err instanceof PlaidError ? err.code : undefined }, 'budget: bank sync failed');
      await pool.query('UPDATE budget_bank_links SET status = $2, last_error = $3 WHERE id = $1', [id, needsLogin ? 'needs_login' : 'error', msg]);
      throw err;
    }
  }

  /** Every active link, one after another; one bank failing does not stop the rest. */
  async syncAll(): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: string }>(`SELECT id FROM budget_bank_links WHERE status = 'active'`);
    for (const { id } of rows) {
      try { await this.syncOne(id); } catch { /* recorded on the link by syncOne */ }
    }
  }

  async remove(id: string): Promise<boolean> {
    const token = await this.deps.secrets.get(TOKEN(id));
    if (token) {
      try { await this.deps.plaid.removeItem(token); } catch (err) { this.deps.logger.warn({ err, linkId: id }, 'budget: Plaid item removal failed; removing the link anyway'); }
    }
    await this.deps.secrets.delete(TOKEN(id));
    const res = await this.deps.pool.query('DELETE FROM budget_bank_links WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Syncs every active link every six hours. Does nothing until Plaid is configured. */
export class BankSyncRunner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly sync: BankSync, private readonly plaid: PlaidClient, private readonly logger: Logger) {}
  start(): void {
    const tick = () => {
      if (this.running) return;
      this.running = true;
      void this.plaid.configured()
        .then(ok => (ok ? this.sync.syncAll() : undefined))
        .catch(err => this.logger.error({ err }, 'budget: scheduled bank sync failed'))
        .finally(() => { this.running = false; });
    };
    this.timer = setInterval(tick, SIX_HOURS);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
