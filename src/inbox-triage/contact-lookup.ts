// contact-lookup.ts — "is the sender in Curia's contacts?", asked before the classifier runs.
//
// A sender who is in the principal's contacts is a warm contact, so a direct ask from them is mail to answer, not
// something to file as FYI or spam. Only the yes/no goes to the model, never the name or details. The From address is
// not verified (mail can be spoofed), so this raises the chance of "Needs a reply"; it never triggers an action.

import type { Logger } from '../logger.js';

/** The part of ContactService this needs, so tests need no database. */
export interface ContactResolver {
  resolveByChannelIdentity(channel: string, identifier: string): Promise<{ tier: string; kind: string } | null>;
}

export interface ContactLookup {
  /** True when the address belongs to a person in Curia's contacts. False on any failure (it only ever adds a hint). */
  isKnown(address: string): Promise<boolean>;
}

const LOOKUP_TIMEOUT_MS = 3_000;
const PLAIN_ADDRESS = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

export function contactLookupFor(resolver: ContactResolver, logger: Logger, timeoutMs = LOOKUP_TIMEOUT_MS): ContactLookup {
  return {
    async isKnown(address: string): Promise<boolean> {
      const trimmed = address.trim();
      if (!PLAIN_ADDRESS.test(trimmed)) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
        const found = await Promise.race([resolver.resolveByChannelIdentity('email', trimmed), timeout]);
        // People only: a company or an automated sender in the address book is not a warm intro. Blocked is the opposite.
        return found !== null && found.kind !== 'automated' && found.kind !== 'organization' && found.tier !== 'blocked';
      } catch (err) {
        logger.warn({ err }, 'inbox-triage: contact lookup failed, classifying without it');
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
