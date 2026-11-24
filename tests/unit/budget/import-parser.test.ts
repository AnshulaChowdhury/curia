import { describe, it, expect } from 'vitest';
import { ImportError, parseBankFile, toCents, toDay } from '../../../src/budget/import-parser.js';

// Every name, number and amount below is invented.
const buf = (s: string) => Buffer.from(s, 'utf8');

describe('toCents / toDay', () => {
  it('reads plain amounts exactly, with no floating point', () => {
    expect(toCents('-12.30')).toBe(-1230);
    expect(toCents('$1,234.5')).toBe(123450);
    expect(toCents('(4.00)')).toBe(-400);
    expect(toCents('0.07')).toBe(7);
    expect(toCents('19.99')).toBe(1999);
    for (const bad of ['', 'abc', '1.234', '1e3', '--1', '12.3.4']) expect(toCents(bad), bad).toBeNull();
  });
  it('reads the three date shapes and rejects impossible days', () => {
    expect(toDay('2031-03-09')).toBe('2031-03-09');
    expect(toDay('20310309120000.000')).toBe('2031-03-09');
    expect(toDay('03/09/2031')).toBe('2031-03-09');
    expect(toDay('2031-02-30')).toBeNull();
    expect(toDay('13/40/2031')).toBeNull();
  });
});

describe('parseBankFile', () => {
  it('reads an RBC csv: payee from Description 1, detail from Description 2, CAD$ signed', () => {
    const csv = 'Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$\n'
      + 'Chequing,0000,3/9/2031,,INVENTED GROCER,Purchase,-25.00,\n'
      + 'Chequing,0000,3/10/2031,,PAYROLL,"Deposit, bi-weekly",1500.00,\n'
      + 'Chequing,0000,not a date,,BROKEN,,-1.00,\n';
    const r = parseBankFile('rbc.csv', buf(csv), 'RBC chequing');
    expect(r.format).toBe('rbc-csv');
    expect(r.skipped).toBe(1);
    expect(r.transactions).toEqual([
      { account: 'RBC chequing', date: '2031-03-09', payee: 'INVENTED GROCER', description: 'Purchase', amountCents: -2500 },
      { account: 'RBC chequing', date: '2031-03-10', payee: 'PAYROLL', description: 'Deposit, bi-weekly', amountCents: 150000 },
    ]);
  });

  it('reads a Tangerine csv', () => {
    const csv = 'Transaction date,Transaction,Name,Memo,Amount\n3/9/2031,DEBIT,Invented Cafe,Latte,-4.50\n';
    const r = parseBankFile('t.csv', buf(csv), 'Tangerine');
    expect(r.format).toBe('tangerine-csv');
    expect(r.transactions[0]).toMatchObject({ date: '2031-03-09', payee: 'Invented Cafe', description: 'Latte', amountCents: -450 });
  });

  it('reads a CIBC csv with no header: debit is money out, credit is money in', () => {
    const csv = '2031-03-09,INVENTED GAS,40.00,,0000\n2031-03-10,REFUND,,12.25,0000\n2031-03-11,EMPTY,,,0000\n';
    const r = parseBankFile('c.csv', buf(csv), 'CIBC');
    expect(r.format).toBe('cibc-csv');
    expect(r.transactions.map(t => t.amountCents)).toEqual([-4000, 1225]);
    expect(r.skipped).toBe(1);
  });

  it('reads an OFX/QBO file whose tags are never closed', () => {
    const ofx = 'OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n'
      + '<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>20310309120000\n<TRNAMT>-25.00\n<FITID>1\n<NAME>INVENTED GROCER\n<MEMO>Purchase\n</STMTTRN>\n'
      + '<STMTTRN>\n<TRNTYPE>CREDIT\n<DTPOSTED>20310310\n<TRNAMT>10.00\n<FITID>2\n<NAME>REFUND\n</STMTTRN>\n'
      + '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
    const r = parseBankFile('a.qbo', buf(ofx), 'RBC visa');
    expect(r.transactions).toEqual([
      { account: 'RBC visa', date: '2031-03-09', payee: 'INVENTED GROCER', description: 'Purchase', amountCents: -2500 },
      { account: 'RBC visa', date: '2031-03-10', payee: 'REFUND', description: '', amountCents: 1000 },
    ]);
  });

  it('refuses an unknown csv, an empty result, and a missing account', () => {
    expect(() => parseBankFile('x.csv', buf('a,b,c\n1,2,3\n'), 'A')).toThrow(ImportError);
    expect(() => parseBankFile('x.ofx', buf('<OFX></OFX>'), 'A')).toThrow(ImportError);
    expect(() => parseBankFile('x.csv', buf('Transaction date,Transaction,Name,Memo,Amount\n3/9/2031,D,N,M,-1\n'), '  ')).toThrow(ImportError);
  });

  it('strips control characters from bank text', () => {
    const csv = 'Transaction date,Transaction,Name,Memo,Amount\n3/9/2031,D,"Bad\u0007  Name",,-1.00\n';
    expect(parseBankFile('t.csv', buf(csv), 'T').transactions[0]!.payee).toBe('Bad Name');
  });
});
