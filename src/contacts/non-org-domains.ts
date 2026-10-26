// src/contacts/non-org-domains.ts
//
// Domains that never identify an organization: personal webmail, shared form /
// scheduling hosts, and hosts shared by many tenants. A reply from one of them says nothing about which business sent it,
// so outreach linking (#2312) never treats a match on one as an `org-domain` link, and
// the send path never records one as an outreach domain.

import { getDomain } from 'tldts';
import { registrableDomain } from '../verification/domain.js';

/** Well-known personal webmail and ISP mail domains that should never generate org nodes (#946). */
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'ymail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.ca',
  'outlook.com',
  'live.com', 'live.ca', 'live.co.uk',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'msn.com',
  'protonmail.com', 'proton.me', 'pm.me',
  // Other webmail providers.
  'gmx.com', 'gmx.de', 'gmx.net', 'mail.com', 'inbox.com', 'hushmail.com',
  'yandex.com', 'yandex.ru', 'mail.ru',
  'zoho.com', 'zohomail.com', 'fastmail.com', 'fastmail.fm', 'hey.com',
  'tutanota.com', 'tuta.io',
  'qq.com', '163.com', '126.com', 'naver.com', 'rediffmail.com',
  // ISP mailboxes: an address on one names a subscriber, not a business.
  'comcast.net', 'att.net', 'verizon.net', 'cox.net', 'charter.net', 'earthlink.net',
  'sbcglobal.net', 'bellsouth.net',
  'rogers.com', 'shaw.ca', 'sympatico.ca', 'bell.net', 'videotron.ca', 'telus.net',
  'cogeco.ca', 'eastlink.ca', 'sasktel.net',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net',
  'orange.fr', 'free.fr', 'laposte.net', 'web.de', 't-online.de', 'libero.it', 'ziggo.nl',
  'bigpond.com', 'optusnet.com.au', 'xtra.co.nz',
]);

/**
 * Hosts that run forms or booking pages for many unrelated businesses. A form on
 * form.typeform.com belongs to whoever embedded it, not to Typeform.
 */
export const FORM_HOST_DOMAINS: ReadonlySet<string> = new Set([
  'typeform.com', 'jotform.com', 'google.com', 'forms.gle', 'calendly.com', 'hubspot.com', 'wufoo.com',
]);

/**
 * Mail and site hosts shared by many unrelated tenants (acme.onmicrosoft.com,
 * shop.myshopify.com, bounce mail from sendgrid.net). Matching on one would link a reply
 * from any tenant to outreach made to another.
 */
export const SHARED_TENANT_DOMAINS: ReadonlySet<string> = new Set([
  'onmicrosoft.com', 'myshopify.com', 'janeapp.com', 'wixsite.com', 'squarespace.com',
  'godaddysites.com', 'mailchimpsites.com', 'sendgrid.net', 'amazonses.com', 'mailgun.org',
  'zendesk.com', 'freshdesk.com', 'helpscoutapp.com', 'intercom-mail.com', 'salesforce.com',
  'hubspotemail.net',
]);

/**
 * True when `domain` (a host or registrable domain, any case) is personal webmail, a
 * shared form host, or a shared tenant host. Subdomains count: mail.gmail.com,
 * form.typeform.com and acme.onmicrosoft.com all match.
 *
 * Also true when the Public Suffix List's private section puts the host under a shared
 * suffix (acme.github.io): the ICANN registrable domain (github.io) then names the
 * hosting provider, not the organization.
 */
export function isNonOrgDomain(domain: string): boolean {
  const host = domain.trim().toLowerCase();
  if (host === '') return false;
  const icann = registrableDomain(host);
  const base = icann ?? host;
  if (icann !== null && getDomain(host, { allowPrivateDomains: true })?.toLowerCase() !== icann) return true;
  return [PERSONAL_EMAIL_DOMAINS, FORM_HOST_DOMAINS, SHARED_TENANT_DOMAINS]
    .some((set) => set.has(base) || set.has(host));
}

/**
 * `security.principal_org_domains` as a lookup set, normalized as the principal-acquaintance
 * check normalizes it (trimmed, lowercased, no trailing dot). The principal's own company
 * is never an outreach org domain: one colleague's address on a row would otherwise link
 * every unrelated mail from that company to the task (#2312).
 */
export function principalOrgDomainSet(domains: readonly string[]): ReadonlySet<string> {
  return new Set(domains.map((d) => d.trim().toLowerCase().replace(/\.$/, '')).filter((d) => d !== ''));
}
