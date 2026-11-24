// INVENTED sample data for the personal budget pages. None of this is real: the payees are made up,
// the amounts are round, and the accounts are fictional. Do not paste real statement data here.
import type { BudgetCategory, BudgetTxn } from './budget-utils.js';

export const FIXTURE_MONTH = '2026-11';

export const FIXTURE_CATEGORIES: BudgetCategory[] = [
  { id: 'cat-groceries', name: 'Groceries', monthlyCents: 60000, rollover: false },
  { id: 'cat-dining', name: 'Eating out', monthlyCents: 25000, rollover: true },
  { id: 'cat-transport', name: 'Transport', monthlyCents: 20000, rollover: false },
  { id: 'cat-home', name: 'Home', monthlyCents: 15000, rollover: false },
  { id: 'cat-fun', name: 'Fun', monthlyCents: 10000, rollover: true },
];

export const FIXTURE_TXNS: BudgetTxn[] = [
  // October (feeds rollover for categories that opt in)
  { id: 't-o1', date: '2026-10-03', payee: 'Example Grocer', amountCents: -48000, categoryId: 'cat-groceries', accountId: 'acct-demo-chequing', source: 'rule', ruleId: 'rule-grocer' },
  { id: 't-o2', date: '2026-10-12', payee: 'Sample Cafe', amountCents: -15000, categoryId: 'cat-dining', accountId: 'acct-demo-card', source: 'rule', ruleId: 'rule-cafe' },
  { id: 't-o3', date: '2026-10-20', payee: 'Demo Cinema', amountCents: -4000, categoryId: 'cat-fun', accountId: 'acct-demo-card', source: 'you', ruleId: null },
  // November
  { id: 't-n1', date: '2026-11-02', payee: 'Example Grocer', amountCents: -32000, categoryId: 'cat-groceries', accountId: 'acct-demo-chequing', source: 'rule', ruleId: 'rule-grocer' },
  { id: 't-n2', date: '2026-11-09', payee: 'Example Grocer', amountCents: -29000, categoryId: 'cat-groceries', accountId: 'acct-demo-chequing', source: 'rule', ruleId: 'rule-grocer' },
  { id: 't-n3', date: '2026-11-05', payee: 'Sample Cafe', amountCents: -22000, categoryId: 'cat-dining', accountId: 'acct-demo-card', source: 'rule', ruleId: 'rule-cafe' },
  { id: 't-n4', date: '2026-11-11', payee: 'Pretend Transit Pass', amountCents: -17500, categoryId: 'cat-transport', accountId: 'acct-demo-card', source: 'agent_guess', ruleId: null },
  { id: 't-n5', date: '2026-11-14', payee: 'Imaginary Hardware', amountCents: -6000, categoryId: 'cat-home', accountId: 'acct-demo-card', source: 'you', ruleId: null },
  { id: 't-n6', date: '2026-11-16', payee: 'Demo Cinema', amountCents: -3500, categoryId: 'cat-fun', accountId: 'acct-demo-card', source: 'you', ruleId: null },
  { id: 't-n7', date: '2026-11-18', payee: 'ACME TEST <b>MARKET</b>', amountCents: -2400, categoryId: null, accountId: 'acct-demo-card', source: 'none', ruleId: null },
  { id: 't-n8', date: '2026-11-19', payee: 'Placeholder Pay Stub', amountCents: 200000, categoryId: null, accountId: 'acct-demo-chequing', source: 'none', ruleId: null },
];
