// books-token.ts — the token the books agent on the Mac mini uses for /books/qbo/*.
//
// Generated on the API connections page and shown once; only its SHA-256 is kept (vault secret `books_api_token_hash`),
// so Curia cannot show it again. BOOKS_API_TOKEN in the environment still works as a fallback.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const HASH_SECRET = 'books_api_token_hash';

export interface BooksTokenSecretsPort {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export class BooksToken {
  constructor(
    private readonly secrets: BooksTokenSecretsPort,
    private readonly envToken: () => string | null = () => process.env.BOOKS_API_TOKEN ?? null,
  ) {}

  /** Makes a new token, replacing any old one. The plaintext is returned once and never stored. */
  async generate(): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.secrets.set(HASH_SECRET, sha256(token).toString('hex'));
    return token;
  }

  async isSet(): Promise<boolean> {
    return (await this.secrets.get(HASH_SECRET)) !== null || !!this.envToken()?.trim();
  }

  /** True when `provided` is the current token. A generated token replaces the environment one. */
  async verify(provided: string): Promise<boolean | null> {
    const stored = await this.secrets.get(HASH_SECRET);
    const expected = stored ? Buffer.from(stored, 'hex') : this.envToken()?.trim() ? sha256(this.envToken()!.trim()) : null;
    if (!expected) return null; // not configured at all
    return timingSafeEqual(sha256(provided), expected);
  }
}
