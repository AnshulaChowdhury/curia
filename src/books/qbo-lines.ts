// qbo-lines.ts — what is already booked in QuickBooks around a batch, as lines the pipeline can compare with the bank's.
//
// A port of books/qbo_read.py (the Python pipeline's reader), kept in step with it. Every kind of entry that moves money
// in or out of one of our bank accounts becomes a line whose sign matches the bank's (money in is positive): purchases,
// deposits, transfers, bill payments, journal entries, and sales and refund receipts. Read through Curia's one QuickBooks
// connection; amounts are summed in cents so no float error reaches the comparison.

import type { QboQueryPort } from './qbo-balances.js';
import type { ServiceAccountInfo, ServiceQboLine } from './books-service-client.js';

const ENTITIES = ['Purchase', 'Deposit', 'Transfer', 'BillPayment', 'JournalEntry', 'SalesReceipt', 'RefundReceipt'] as const;
type Entity = (typeof ENTITIES)[number];
const PAGE = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Ref = { value?: string; name?: string } | undefined;
interface Tx {
  Id?: string;
  TxnDate: string;
  TotalAmt?: number;
  Amount?: number;
  Credit?: boolean;
  PayType?: string;
  PrivateNote?: string;
  AccountRef?: Ref;
  EntityRef?: Ref;
  VendorRef?: Ref;
  CustomerRef?: Ref;
  DepositToAccountRef?: Ref;
  FromAccountRef?: Ref;
  ToAccountRef?: Ref;
  CheckPayment?: { BankAccountRef?: Ref };
  CreditCardPayment?: { CCAccountRef?: Ref };
  Line?: Array<Record<string, unknown> & { Description?: string; Amount?: number }>;
}

const cents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const money = (c: number): string => (c / 100).toFixed(2);
const refName = (r: Ref): string => r?.name ?? '';

function firstLineCategory(lines: Tx['Line']): string {
  for (const ln of lines ?? []) {
    for (const key of ['AccountBasedExpenseLineDetail', 'DepositLineDetail', 'JournalEntryLineDetail']) {
      const name = refName((ln[key] as { AccountRef?: Ref } | undefined)?.AccountRef);
      if (name) return name;
    }
  }
  return '';
}

function note(tx: Tx): string {
  return [tx.PrivateNote ?? '', ...(tx.Line ?? []).map(l => l.Description ?? '')].filter(Boolean).join(' ').trim();
}

/** The lines one QuickBooks entry produces. `ours` maps a QuickBooks account id to our account id. */
export function linesFor(entity: Entity, tx: Tx, ours: ReadonlyMap<string, string>): ServiceQboLine[] {
  const out: ServiceQboLine[] = [];
  const base = { id: `${entity}:${tx.Id}`, date: tx.TxnDate, description: note(tx), line: 0 };
  const add = (ref: Ref, amountCents: number, name = '', category = ''): void => {
    const account = ref?.value ? ours.get(ref.value) : undefined;
    if (account) out.push({ ...base, amount: money(amountCents), name, category, account });
  };
  const total = cents(tx.TotalAmt);
  switch (entity) {
    case 'Purchase': // a credit-card Purchase with Credit true is a refund from the vendor: money back onto the card
      add(tx.AccountRef, (tx.Credit ? 1 : -1) * total, refName(tx.EntityRef), firstLineCategory(tx.Line));
      break;
    case 'Deposit':
      add(tx.DepositToAccountRef, total, '', firstLineCategory(tx.Line));
      break;
    case 'Transfer': {
      const amount = cents(tx.Amount);
      add(tx.FromAccountRef, -amount, '', refName(tx.ToAccountRef));
      add(tx.ToAccountRef, amount, '', refName(tx.FromAccountRef));
      break;
    }
    case 'BillPayment':
      add(tx.PayType === 'Check' ? tx.CheckPayment?.BankAccountRef : tx.CreditCardPayment?.CCAccountRef, -total, refName(tx.VendorRef));
      break;
    case 'JournalEntry':
      for (const ln of tx.Line ?? []) {
        const d = ln['JournalEntryLineDetail'] as { AccountRef?: Ref; PostingType?: string; Entity?: { EntityRef?: Ref } } | undefined;
        const amount = cents(ln.Amount);
        add(d?.AccountRef, d?.PostingType === 'Debit' ? amount : -amount, refName(d?.Entity?.EntityRef));
      }
      break;
    case 'SalesReceipt':
      add(tx.DepositToAccountRef, total, refName(tx.CustomerRef));
      break;
    case 'RefundReceipt':
      add(tx.DepositToAccountRef, -total, refName(tx.CustomerRef));
      break;
  }
  return out;
}

async function queryAll<T>(qbo: QboQueryPort, entity: string, where = ''): Promise<T[]> {
  const out: T[] = [];
  for (let start = 1; ; start += PAGE) {
    const res = (await qbo.api('GET', 'query', { query: `select * from ${entity}${where} STARTPOSITION ${start} MAXRESULTS ${PAGE}` })) as {
      QueryResponse?: Record<string, T[] | undefined>;
    };
    const rows = res.QueryResponse?.[entity] ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** QuickBooks account id -> our account id, by the account names the service lists. */
export async function accountMap(qbo: QboQueryPort, accounts: readonly ServiceAccountInfo[]): Promise<Map<string, string>> {
  const wanted = new Map(accounts.map(a => [a.qbo_account, a.id]));
  const found = new Map<string, string>();
  for (const row of await queryAll<{ Id: string; Name?: string; FullyQualifiedName?: string }>(qbo, 'Account')) {
    const ours = [row.FullyQualifiedName, row.Name].map(n => (n ? wanted.get(n) : undefined)).find(Boolean);
    if (ours) found.set(row.Id, ours);
  }
  const missing = accounts.filter(a => ![...found.values()].includes(a.id)).map(a => a.id);
  if (missing.length > 0) throw new Error(`QuickBooks has no account for: ${missing.sort().join(', ')}`);
  return found;
}

/** Every line in the window. The service says which window (it already includes the look-around). */
export async function loadQboLines(
  qbo: QboQueryPort,
  accounts: readonly ServiceAccountInfo[],
  window: { start: string; end: string },
): Promise<ServiceQboLine[]> {
  if (!DAY.test(window.start) || !DAY.test(window.end)) throw new Error('The QuickBooks window must be two YYYY-MM-DD dates');
  const ours = await accountMap(qbo, accounts);
  const lines: ServiceQboLine[] = [];
  for (const entity of ENTITIES) {
    for (const tx of await queryAll<Tx>(qbo, entity, ` where TxnDate >= '${window.start}' and TxnDate <= '${window.end}'`)) {
      lines.push(...linesFor(entity, tx, ours));
    }
  }
  return lines;
}
