// Evidence that the principal knows an email sender (#2227).

import { describe, it, expect, vi } from 'vitest';
import { PrincipalAcquaintanceCheck, isPlainAddress, type PrincipalMailbox } from '../../../src/contacts/principal-acquaintance.js';
import { createLogger } from '../../../src/logger.js';

function check(opts: { orgDomains?: string[]; principal?: string[]; mailbox?: PrincipalMailbox; now?: () => number } = {}) {
  return new PrincipalAcquaintanceCheck({
    orgDomains: opts.orgDomains ?? ['acme.example'],
    principalEmails: () => opts.principal ?? ['avery@acme.example'],
    mailbox: opts.mailbox,
    logger: createLogger('error'),
    now: opts.now,
  });
}

function mailbox(sent: boolean | Error) {
  return {
    hasSentTo: vi.fn(async () => {
      if (sent instanceof Error) throw sent;
      return sent;
    }),
  };
}

describe('PrincipalAcquaintanceCheck', () => {
  it('counts a configured organization domain, whatever the case', async () => {
    const mb = mailbox(false);
    expect(await check({ mailbox: mb }).evidenceFor('Priya.Shah@ACME.example')).toBe('principal-domain');
    expect(mb.hasSentTo).not.toHaveBeenCalled();
  });

  it('never derives a domain from the principal\'s own address', async () => {
    const c = check({ orgDomains: [], principal: ['avery@web.example'], mailbox: mailbox(false) });
    expect(await c.evidenceFor('stranger@web.example')).toBeNull();
  });

  it('matches the exact domain only, not a subdomain or a look-alike', async () => {
    const c = check({ mailbox: mailbox(false) });
    expect(await c.evidenceFor('x@mail.acme.example')).toBeNull();
    expect(await c.evidenceFor('x@acme.example.evil.example')).toBeNull();
    expect(await c.evidenceFor('x@notacme.example')).toBeNull();
  });

  it('accepts a configured domain with a trailing dot or capitals', async () => {
    expect(await check({ orgDomains: ['ACME.example.'] }).evidenceFor('x@acme.example')).toBe('principal-domain');
  });

  it('counts mail the principal sent to the address', async () => {
    const mb = mailbox(true);
    expect(await check({ mailbox: mb }).evidenceFor('morgan.lee@lumen.example')).toBe('principal-correspondence');
    expect(mb.hasSentTo).toHaveBeenCalledWith('morgan.lee@lumen.example');
  });

  it('is null with no evidence, and with no mailbox for an outside domain', async () => {
    expect(await check({ mailbox: mailbox(false) }).evidenceFor('morgan.lee@lumen.example')).toBeNull();
    expect(await check().evidenceFor('morgan.lee@lumen.example')).toBeNull();
  });

  it('reads a mailbox failure as no evidence', async () => {
    expect(await check({ mailbox: mailbox(new Error('nylas down')) }).evidenceFor('morgan.lee@lumen.example')).toBeNull();
  });

  it('does not cache a failure: the next message asks the mailbox again', async () => {
    const mb = mailbox(new Error('nylas down'));
    const c = check({ mailbox: mb, now: () => 0 });
    expect(await c.evidenceFor('morgan.lee@lumen.example')).toBeNull();
    mb.hasSentTo.mockResolvedValue(true);
    expect(await c.evidenceFor('morgan.lee@lumen.example')).toBe('principal-correspondence');
    expect(mb.hasSentTo).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between concurrent checks of the same address', async () => {
    let answer!: (sent: boolean) => void;
    const mb = { hasSentTo: vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; })) };
    const c = check({ mailbox: mb });
    const first = c.evidenceFor('morgan.lee@lumen.example');
    const second = c.evidenceFor('Morgan.Lee@lumen.example');
    answer(true);
    expect(await Promise.all([first, second])).toEqual(['principal-correspondence', 'principal-correspondence']);
    expect(mb.hasSentTo).toHaveBeenCalledTimes(1);
  });

  it('never matches the principal\'s own address', async () => {
    expect(await check({ mailbox: mailbox(true) }).evidenceFor('avery@acme.example')).toBeNull();
  });

  it('never searches for a value that is not one plain address', async () => {
    const mb = mailbox(true);
    const c = check({ mailbox: mb });
    for (const raw of ['x@y.example OR from:z@w.example', '"a b"@y.example', 'not-an-address', 'a@b.example)']) {
      expect(await c.evidenceFor(raw)).toBeNull();
    }
    expect(mb.hasSentTo).not.toHaveBeenCalled();
  });

  it('caches a positive answer, and re-checks a negative one after an hour', async () => {
    let t = 0;
    const mb = mailbox(false);
    const c = check({ mailbox: mb, now: () => t });
    await c.evidenceFor('morgan.lee@lumen.example');
    t = 30 * 60_000;
    await c.evidenceFor('morgan.lee@lumen.example');
    expect(mb.hasSentTo).toHaveBeenCalledTimes(1);
    t = 61 * 60_000;
    mb.hasSentTo.mockResolvedValue(true);
    expect(await c.evidenceFor('morgan.lee@lumen.example')).toBe('principal-correspondence');
    t = 1_000 * 60 * 60_000;
    expect(await c.evidenceFor('morgan.lee@lumen.example')).toBe('principal-correspondence');
    expect(mb.hasSentTo).toHaveBeenCalledTimes(2);
  });
});

describe('isPlainAddress', () => {
  it.each(['a@b.example', 'first.last+tag@sub.domain.example', "o'brien@x.example"])('accepts %s', (a) => {
    expect(isPlainAddress(a)).toBe(true);
  });
  it.each(['a b@c.example', 'a@b', '<a@b.example>', 'a@b.example,c@d.example'])('rejects %s', (a) => {
    expect(isPlainAddress(a)).toBe(false);
  });
});
