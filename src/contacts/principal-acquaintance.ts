// principal-acquaintance.ts — is an unknown email sender someone the principal knows? (#2227)
//
// A new email sender reaches the coordinator as tier `unknown`, which runs it read-only:
// no calendar, no outbound mail. Someone the principal already works or corresponds with
// (a colleague at the principal's organization, an acquaintance they have written to) was
// declined as a stranger. The dispatcher asks this check before routing, and elevates the
// contact to `known` when it finds evidence, so the first message is handled as the
// principal would expect.
//
// Two kinds of evidence, both about the principal's own world, never the sender's claims:
//   - principal-domain: the sender's address is on one of the principal's organization
//     domains (`security.principal_org_domains`). An explicit list, not one derived from the
//     principal's own address: a derived domain could be a shared mail provider nobody
//     thought to exclude, and then anyone with an address there would count. Empty: off.
//   - principal-correspondence: the principal has sent mail to this address. Mail the
//     sender sent the principal does not count; anyone can write to anyone.
// The dispatcher asks only for a sender whose mail passed SPF, DKIM and DMARC, so the
// address itself is not spoofed.

import type { Logger } from '../logger.js';

export type AcquaintanceEvidence = 'principal-domain' | 'principal-correspondence';

/** The principal's mailbox, as far as this check needs it. */
export interface PrincipalMailbox {
  /** Whether the principal has sent at least one message to this address. Throws on failure. */
  hasSentTo(address: string): Promise<boolean>;
}

// One plain address and nothing else: it goes into a mailbox search query, so a value
// with spaces, quotes or parentheses could widen the search ("x OR from:y").
const PLAIN_ADDRESS = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function isPlainAddress(address: string): boolean {
  return PLAIN_ADDRESS.test(address);
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at === -1 ? null : address.slice(at + 1).toLowerCase();
}

// Results are cached per address: a positive one does not change, and a negative one is
// re-checked after an hour so a reply the principal sends later still counts. A failed
// lookup is not cached (a mailbox outage is not evidence of no correspondence), so the next
// message asks again. Lookups already running are shared, so a burst of messages from one
// sender makes one mailbox request.
const NEGATIVE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 2_000;

export interface PrincipalAcquaintanceCheckOptions {
  /** `security.principal_org_domains`: exact domains only (a subdomain is not included). */
  orgDomains: readonly string[];
  /** The principal's own email addresses, read on every check; never evidence for themselves. */
  principalEmails: () => readonly string[];
  /** Absent when the principal's mailbox is not connected: only the domain rule applies. */
  mailbox?: PrincipalMailbox;
  logger: Logger;
  now?: () => number;
}

export class PrincipalAcquaintanceCheck {
  private readonly cache = new Map<string, { evidence: AcquaintanceEvidence | null; at: number }>();
  private readonly inFlight = new Map<string, Promise<AcquaintanceEvidence | null>>();
  private readonly orgDomains: ReadonlySet<string>;

  constructor(private readonly options: PrincipalAcquaintanceCheckOptions) {
    this.orgDomains = new Set(options.orgDomains.map((d) => d.trim().toLowerCase().replace(/\.$/, '')));
  }

  /**
   * Evidence that the principal knows this address, or null. A mailbox failure is logged
   * and read as no evidence: the sender stays `unknown`, which is where they started.
   */
  async evidenceFor(rawAddress: string): Promise<AcquaintanceEvidence | null> {
    const address = rawAddress.trim().toLowerCase();
    if (!isPlainAddress(address)) return null;
    const domain = domainOf(address);
    if (domain === null) return null;
    if (this.options.principalEmails().some((e) => e.trim().toLowerCase() === address)) return null;
    if (this.orgDomains.has(domain)) return 'principal-domain';

    const mailbox = this.options.mailbox;
    if (!mailbox) return null;
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(address);
    if (cached && (cached.evidence !== null || now - cached.at < NEGATIVE_TTL_MS)) return cached.evidence;

    const running = this.inFlight.get(address);
    if (running) return running;
    const lookup = this.lookUp(mailbox, address, now).finally(() => this.inFlight.delete(address));
    this.inFlight.set(address, lookup);
    return lookup;
  }

  private async lookUp(mailbox: PrincipalMailbox, address: string, now: number): Promise<AcquaintanceEvidence | null> {
    let evidence: AcquaintanceEvidence | null;
    try {
      evidence = (await mailbox.hasSentTo(address)) ? 'principal-correspondence' : null;
    } catch (err) {
      this.options.logger.warn({ err }, 'principal acquaintance: mailbox lookup failed — sender stays unknown');
      return null;
    }
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(address, { evidence, at: now });
    return evidence;
  }
}
