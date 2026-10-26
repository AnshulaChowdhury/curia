// src/contacts/non-org-domains.ts
//
// Domains that never identify an organization: personal webmail and shared form /
// scheduling hosts. A reply from one of them says nothing about which business sent it,
// so outreach linking (#2312) never treats a match on one as an `org-domain` link, and
// the send path never records one as an outreach domain.

import { registrableDomain } from '../verification/domain.js';

/** Well-known personal webmail domains that should never generate org nodes (#946). */
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
]);

/**
 * Hosts that run forms or booking pages for many unrelated businesses. A form on
 * form.typeform.com belongs to whoever embedded it, not to Typeform.
 */
export const FORM_HOST_DOMAINS: ReadonlySet<string> = new Set([
  'typeform.com', 'jotform.com', 'google.com', 'forms.gle', 'calendly.com', 'hubspot.com', 'wufoo.com',
]);

/**
 * True when `domain` (a host or registrable domain, any case) is personal webmail or a
 * shared form host. Subdomains count: mail.gmail.com and form.typeform.com both match.
 */
export function isNonOrgDomain(domain: string): boolean {
  const host = domain.trim().toLowerCase();
  if (host === '') return false;
  const base = registrableDomain(host) ?? host;
  return PERSONAL_EMAIL_DOMAINS.has(base) || PERSONAL_EMAIL_DOMAINS.has(host)
    || FORM_HOST_DOMAINS.has(base) || FORM_HOST_DOMAINS.has(host);
}
