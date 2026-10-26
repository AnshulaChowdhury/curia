// tests/unit/contacts/non-org-domains.test.ts
//
// Which domains never identify an organization for outreach linking (#2312): webmail,
// shared form hosts, shared tenant hosts, and anything under a private public suffix.

import { describe, it, expect } from 'vitest';
import { isNonOrgDomain, principalOrgDomainSet } from '../../../src/contacts/non-org-domains.js';
import { orgDomainsOf } from '../../../src/dispatch/task-outreach-capability.js';

describe('isNonOrgDomain', () => {
  it.each([
    'gmail.com', 'mail.gmail.com', 'form.typeform.com', 'calendly.com',
    'onmicrosoft.com', 'evil.onmicrosoft.com', 'shop.myshopify.com', 'bounces.sendgrid.net',
    'acme.janeapp.com', 'em.hubspotemail.net',
  ])('%s is non-org', (host) => {
    expect(isNonOrgDomain(host)).toBe(true);
  });

  it.each(['acme.github.io', 'github.io', 'x.herokuapp.com'])('private-suffix host %s is non-org', (host) => {
    expect(isNonOrgDomain(host)).toBe(true);
  });

  it.each(['acme.example', 'bookings.acme.com', 'ACME.co.uk'])('corporate domain %s is an org domain', (host) => {
    expect(isNonOrgDomain(host)).toBe(false);
  });
});

describe('orgDomainsOf', () => {
  it('keeps corporate domains and drops webmail, tenant and private-suffix hosts', () => {
    expect(orgDomainsOf([
      'owner@acme.onmicrosoft.com', 'jo@gmail.com', 'site@acme.github.io', 'bookings@mail.acme.example', '+14165550100',
    ])).toEqual(['acme.example']);
  });

  it("drops the principal's own domains, by registrable domain or full host", () => {
    const own = principalOrgDomainSet([' Office.Example. ', 'mail.corp.example', '']);
    expect([...own]).toEqual(['office.example', 'mail.corp.example']);
    expect(orgDomainsOf(['a@office.example', 'b@team.office.example', 'c@mail.corp.example', 'd@acme.example'], own))
      .toEqual(['acme.example']);
  });
});
