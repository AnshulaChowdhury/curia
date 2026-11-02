import { describe, it, expect } from 'vitest';
import { BankFileError, displayName, MAX_UPLOAD_BYTES, validateBankFile } from '../../../src/books/bank-file.js';

const OFX = Buffer.from('OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>');

describe('displayName', () => {
  it('drops any path, control characters and angle brackets, and caps the length', () => {
    expect(displayName('../../etc/passwd week 1.qbo')).toBe('passwd week 1.qbo');
    expect(displayName('C:\\Users\\a\\Chequing.qbo')).toBe('Chequing.qbo');
    expect(displayName('a\u0000b\nc<script>.qbo')).toBe('abcscript.qbo');
    expect(displayName('x'.repeat(300) + '.qbo').length).toBe(120);
    expect(displayName('..')).toBe('..');
  });
});

describe('validateBankFile', () => {
  it('accepts an OFX/QBO download and a CSV with a header row', () => {
    expect(validateBankFile('Chequing Oct.QBO', OFX).name).toBe('Chequing Oct.QBO');
    expect(validateBankFile('a.ofx', OFX).name).toBe('a.ofx');
    expect(validateBankFile('card.csv', Buffer.from('Date,Description,Amount\n2026-10-01,X,1.00\n')).name).toBe('card.csv');
  });

  it('refuses other extensions, empty, oversized and binary files', () => {
    for (const [name, bytes] of [
      ['notes.pdf', OFX], ['a.qbo.exe', OFX], ['', OFX], ['.qbo.', OFX],
      ['a.qbo', Buffer.alloc(0)],
      ['big.qbo', Buffer.concat([OFX, Buffer.alloc(MAX_UPLOAD_BYTES)])],
      ['bin.qbo', Buffer.concat([OFX, Buffer.from([0, 1, 2])])],
    ] as Array<[string, Buffer]>) {
      expect(() => validateBankFile(name, bytes), name).toThrow(BankFileError);
    }
  });

  it('refuses a .qbo that is not OFX and a .csv with no delimiter in its first line', () => {
    expect(() => validateBankFile('x.qbo', Buffer.from('hello world'))).toThrow(/does not look like/);
    expect(() => validateBankFile('x.csv', Buffer.from('just one long line of words\n'))).toThrow(/does not look like/);
  });
});
