// clear-site-data.ts — the clear_site_data action (#2244): forget one site in the browser
// profile, leaving every other site signed in.
//
// The recovery for an interrupted sign-in. When the agent navigated away mid-chain from
// Air Canada's sign-in, the login service kept a session but aircanada.com never got its
// signed-in cookie, and every later /signin in the profile hung on a blank consent page.
// Before this action the only way out was an incognito session, which can't keep a sign-in.

import type { BrowserContext, Frame, Page } from 'playwright';
import type { ToolContext } from '../../../../src/skills/types.js';
import { getDomain, getHostname } from 'tldts';

/**
 * Hosts that serve many unrelated tenants as subdomains but are not on the Public Suffix
 * List, so the PSL would scope a tenant to the whole host (acme.okta.com → okta.com).
 * For these a tenant is one label to the left of the suffix. Data, not logic: add a
 * shared sign-in host here in one line. Longer suffixes first (us.auth0.com before auth0.com).
 */
export const MULTI_TENANT_SUFFIXES: readonly string[] = [
  'us.auth0.com', 'eu.auth0.com', 'au.auth0.com', 'jp.auth0.com', 'auth0.com',
  'okta.com', 'oktapreview.com', 'okta-emea.com',
  'b2clogin.com',
  'onelogin.com',
  'my.salesforce.com', 'my.site.com',
];

export interface ClearSiteDataResult {
  /** The site cleared: the registrable domain ("aircanada.com" for "www.aircanada.com"),
   *  or one tenant on a shared host ("acme.okta.com", "foo.github.io"). */
  site: string;
  cookiesCleared: number;
  /** Origins whose storage was cleared. */
  originsCleared: string[];
}

/**
 * Normalize a `domain` input to the site it belongs to, or null when it has none (an IP
 * address, a bare public suffix, junk). Accepts a bare host or a URL. A tenant on a shared
 * host is its own site, so clearing it leaves the principal's other tenants there signed
 * in: PSL private suffixes count (foo.github.io), and so do MULTI_TENANT_SUFFIXES
 * (acme.okta.com, acme.us.auth0.com).
 */
export function siteForDomainInput(domain: string): string | null {
  const trimmed = domain.trim();
  if (trimmed === '' || /[\s/\\]/.test(trimmed.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))) return null;
  const site = getDomain(trimmed, { allowPrivateDomains: true });
  if (site === null) return null;
  const host = (getHostname(trimmed) ?? '').toLowerCase();
  for (const suffix of MULTI_TENANT_SUFFIXES) {
    if (host.endsWith(`.${suffix}`)) {
      const labels = host.slice(0, -(suffix.length + 1)).split('.');
      return `${labels[labels.length - 1]}.${suffix}`;
    }
  }
  return site.toLowerCase();
}

/** True when cookie domain or host `host` is `site` or one of its subdomains. */
function onSite(host: string, site: string): boolean {
  const h = host.replace(/^\./, '').toLowerCase();
  return h === site || h.endsWith(`.${site}`);
}

/**
 * Clear `site`'s cookies (its own and every subdomain's) and its origins' storage from
 * `context`. Storage is cleared per origin, so the origins are gathered from the cookies
 * being removed, the frames open on the site, and the site's bare and www hosts.
 */
export async function clearSiteData(
  context: BrowserContext,
  page: Page,
  site: string,
  log: ToolContext['log'],
): Promise<ClearSiteDataResult> {
  const cookies = await context.cookies();
  const siteCookies = cookies.filter((c) => onSite(c.domain, site));

  const hosts = new Set<string>([site, `www.${site}`]);
  for (const c of siteCookies) hosts.add(c.domain.replace(/^\./, '').toLowerCase());
  const siteFrames: Frame[] = [];
  for (const openPage of context.pages()) {
    for (const frame of openPage.frames()) {
      let host: string;
      try {
        host = new URL(frame.url()).hostname.toLowerCase();
      } catch {
        // about:blank and the like have no host to clear.
        continue;
      }
      if (onSite(host, site)) {
        hosts.add(host);
        siteFrames.push(frame);
      }
    }
  }

  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await context.clearCookies({ domain: new RegExp(`(^|\\.)${escaped}$`, 'i') });

  const origins = [...hosts].sort().flatMap((host) => [`https://${host}`, `http://${host}`]);
  const cdp = await context.newCDPSession(page);
  try {
    for (const origin of origins) {
      // 'all' covers local storage, IndexedDB, cache storage and service workers.
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    }
  } finally {
    await cdp.detach().catch((err: unknown) => log.debug({ err }, 'clear_site_data: CDP session detach failed'));
  }

  // Session storage belongs to a tab, not an origin, so the CDP call above leaves it.
  // Clear it in the frames open on the site; a frame that is navigating is skipped.
  for (const frame of siteFrames) {
    // A string expression: this file has no DOM lib (see dom-extract.ts).
    await frame.evaluate('sessionStorage.clear()').catch((err: unknown) =>
      // Origin only: a frame mid-navigation may be on a callback URL carrying an auth code.
      log.debug({ err, frameOrigin: originOf(frame.url()) }, 'clear_site_data: could not clear session storage in a frame'),
    );
  }

  log.info({ site, cookiesCleared: siteCookies.length, origins: origins.length }, 'Cleared site data from the browser profile');
  return { site, cookiesCleared: siteCookies.length, originsCleared: origins };
}

/** The origin of `url`, or a placeholder when it has none. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // Not a URL (about:blank already has origin "null"); nothing identifying to log.
    return '(no origin)';
  }
}
