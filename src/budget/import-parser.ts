// import-parser.ts — turns a bank download (.qbo/.ofx, or the .csv from RBC, Tangerine or CIBC) into budget transactions.
//
// Bank files are untrusted text. This reads fields and nothing else: no value is ever executed, used as a path, or put in
// a query. Amounts are whole cents (negative = money out); a row that cannot be read is counted as skipped, never guessed.

import type { NewTransaction } from './budget-store.js';

export type ImportFormat = 'ofx' | 'rbc-csv' | 'tangerine-csv' | 'cibc-csv';

export interface ParsedImport {
  format: ImportFormat;
  transactions: NewTransaction[];
  skipped: number;
}

export class ImportError extends Error {}

/** "-12.30", "$1,234.5", "(4.00)" to cents, or null when it is not a plain amount. Integer arithmetic only. */
export function toCents(raw: string): number | null {
  let s = raw.trim().replace(/[$,\s]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return negative && cents !== 0 ? -cents : cents;
}

function validDay(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** YYYY-MM-DD, YYYYMMDD[...] or MM/DD/YYYY to YYYY-MM-DD, or null. */
export function toDay(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? validDay(Number(m[3]), Number(m[1]), Number(m[2])) : null;
}

/** A small RFC-4180 reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

const clean = (s: string | undefined): string => (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function parseOfx(text: string, account: string): ParsedImport {
  const out: NewTransaction[] = [];
  let skipped = 0;
  // OFX 1.x is SGML: tags often have no closing tag, so read "<TAG>value" up to the next "<" or line end.
  const field = (block: string, tag: string): string => new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block)?.[1]?.trim() ?? '';
  for (const block of text.split(/<STMTTRN>/i).slice(1)) {
    const date = toDay(field(block, 'DTPOSTED'));
    const amountCents = toCents(field(block, 'TRNAMT'));
    if (!date || amountCents === null) { skipped++; continue; }
    const name = clean(field(block, 'NAME'));
    const memo = clean(field(block, 'MEMO'));
    out.push({ account, date, payee: name || memo, description: name && memo && memo !== name ? memo : '', amountCents });
  }
  return { format: 'ofx', transactions: out, skipped };
}

const norm = (s: string): string => s.trim().toLowerCase();

function fromRows(format: ImportFormat, rows: string[][], account: string, read: (r: string[]) => NewTransaction | null): ParsedImport {
  const transactions: NewTransaction[] = [];
  let skipped = 0;
  for (const r of rows) {
    const t = read(r);
    if (t) transactions.push({ ...t, account }); else skipped++;
  }
  return { format, transactions, skipped };
}

function parseCsvFile(text: string, account: string): ParsedImport {
  const rows = parseCsv(text);
  const first = rows[0]?.map(norm) ?? [];
  const col = (name: string) => first.indexOf(name);

  // RBC: Account Type, Account Number, Transaction Date, Cheque Number, Description 1, Description 2, CAD$, USD$
  if (first.includes('description 1') && first.includes('transaction date')) {
    const [d, p, q, a] = [col('transaction date'), col('description 1'), col('description 2'), col('cad$')];
    if (a < 0) throw new ImportError('That RBC file has no CAD$ column');
    return fromRows('rbc-csv', rows.slice(1), account, r => {
      const date = toDay(r[d] ?? ''); const amountCents = toCents(r[a] ?? '');
      return date && amountCents !== null ? { account, date, payee: clean(r[p]), description: clean(r[q]), amountCents } : null;
    });
  }
  // Tangerine: Transaction date, Transaction, Name, Memo, Amount
  if (first.includes('transaction date') && first.includes('name') && first.includes('amount')) {
    const [d, p, q, a] = [col('transaction date'), col('name'), col('memo'), col('amount')];
    return fromRows('tangerine-csv', rows.slice(1), account, r => {
      const date = toDay(r[d] ?? ''); const amountCents = toCents(r[a] ?? '');
      return date && amountCents !== null ? { account, date, payee: clean(r[p]), description: clean(r[q]), amountCents } : null;
    });
  }
  // CIBC has no header: date, description, debit, credit[, card number]
  if (rows[0] && toDay(rows[0][0] ?? '') && rows[0].length >= 4) {
    return fromRows('cibc-csv', rows, account, r => {
      const date = toDay(r[0] ?? '');
      const debit = (r[2] ?? '').trim() === '' ? 0 : toCents(r[2]!);
      const credit = (r[3] ?? '').trim() === '' ? 0 : toCents(r[3]!);
      if (!date || debit === null || credit === null || (debit === 0 && credit === 0)) return null;
      return { account, date, payee: clean(r[1]), description: '', amountCents: credit - debit };
    });
  }
  throw new ImportError('That CSV is not an RBC, Tangerine or CIBC download Curia recognises');
}

export function parseBankFile(name: string, bytes: Buffer, account: string): ParsedImport {
  const acct = clean(account).slice(0, 60);
  if (!acct) throw new ImportError('Say which account this file is for');
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const lower = name.toLowerCase();
  const parsed = lower.endsWith('.csv') ? parseCsvFile(text, acct) : parseOfx(text, acct);
  if (parsed.transactions.length === 0) throw new ImportError('No transactions could be read from that file');
  return parsed;
}
