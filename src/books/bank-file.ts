// bank-file.ts — what may be uploaded as a bank file, and how its name is shown.
//
// Bank files are untrusted input: Curia never parses them, but it refuses anything that is not plainly a bank download
// (.qbo/.ofx/.csv text of a sensible size), and never uses the uploaded name as a path.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const EXTENSIONS = ['.qbo', '.ofx', '.csv'];

export class BankFileError extends Error {}

/** A display-only name: no path, no control characters, at most 120 characters. */
export function displayName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(-120);
  return cleaned;
}

export function validateBankFile(rawName: string, bytes: Buffer): { name: string } {
  const name = displayName(rawName);
  if (!name || !EXTENSIONS.some(e => name.toLowerCase().endsWith(e))) {
    throw new BankFileError('Only .qbo, .ofx and .csv files can be uploaded');
  }
  if (bytes.length === 0) throw new BankFileError('That file is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new BankFileError('That file is larger than 5 MB');
  if (bytes.includes(0)) throw new BankFileError('That does not look like a bank file (it contains binary data)');
  const head = bytes.subarray(0, 4096).toString('latin1');
  const lower = name.toLowerCase();
  const looksOfx = /OFXHEADER|<OFX>/i.test(head);
  if (lower.endsWith('.csv')) {
    if (!/[,;\t]/.test(head.split(/\r?\n/)[0] ?? '')) throw new BankFileError('That does not look like a CSV bank file');
  } else if (!looksOfx) {
    throw new BankFileError('That does not look like a .qbo/.ofx bank download');
  }
  return { name };
}
