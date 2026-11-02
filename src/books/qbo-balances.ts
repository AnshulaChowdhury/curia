// qbo-balances.ts — the three balances shown in the Morning Brief, read from QuickBooks through Curia's own connection.
//
// Cash in bank is the sum of the Bank accounts; Liabilities the sum of Accounts Payable, Credit Card, Other Current
// Liability and Long Term Liability accounts (each shown as the amount owed); Accounts Receivable the receivable account(s).
// Each account's own CurrentBalance is summed (not the roll-up), so a sub-account is never counted twice.

export interface Balances {
  cash: number;
  liabilities: number;
  receivable: number;
}

interface AccountRow {
  AccountType?: string;
  CurrentBalance?: number;
}

const LIABILITY_TYPES = new Set(['Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability']);
const PAGE = 1000;

/** The slice of QboConnection this needs. */
export interface QboQueryPort {
  api(method: 'GET' | 'POST', path: string, params?: Record<string, string>, body?: unknown): Promise<unknown>;
}

export async function quickbooksBalances(qbo: QboQueryPort): Promise<Balances> {
  let cash = 0;
  let liabilities = 0;
  let receivable = 0;
  for (let start = 1; ; start += PAGE) {
    const out = (await qbo.api('GET', 'query', { query: `select * from Account STARTPOSITION ${start} MAXRESULTS ${PAGE}` })) as {
      QueryResponse?: { Account?: AccountRow[] };
    };
    const rows = out.QueryResponse?.Account ?? [];
    for (const a of rows) {
      const cents = Math.round((typeof a.CurrentBalance === 'number' ? a.CurrentBalance : 0) * 100);
      if (a.AccountType === 'Bank') cash += cents;
      else if (a.AccountType === 'Accounts Receivable') receivable += cents;
      else if (a.AccountType && LIABILITY_TYPES.has(a.AccountType)) liabilities += cents;
    }
    if (rows.length < PAGE) break;
  }
  return { cash: cash / 100, liabilities: liabilities / 100, receivable: receivable / 100 };
}
