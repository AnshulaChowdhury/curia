// import-token.ts — the token the Mac mini uses for POST /contacts/import.
//
// Generated on the API connections page and shown once; only its SHA-256 is kept (vault secret
// `contacts_import_token_hash`), so Curia cannot show it again. Same scheme as the books token
// (src/quickbooks/books-token.ts). There is no environment fallback: without a token the import route is 404.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const HASH_SECRET = 'contacts_import_token_hash';

export interface ImportTokenSecretsPort {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export class ContactsImportToken {
  constructor(private readonly secrets: ImportTokenSecretsPort) {}

  /** Makes a new token, replacing any old one. The plaintext is returned once and never stored. */
  async generate(): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.secrets.set(HASH_SECRET, sha256(token).toString('hex'));
    return token;
  }

  async isSet(): Promise<boolean> {
    return (await this.secrets.get(HASH_SECRET)) !== null;
  }

  /** True when `provided` is the current token; null when no token has been made yet. */
  async verify(provided: string): Promise<boolean | null> {
    const stored = await this.secrets.get(HASH_SECRET);
    if (!stored) return null;
    return timingSafeEqual(sha256(provided), Buffer.from(stored, 'hex'));
  }
}
