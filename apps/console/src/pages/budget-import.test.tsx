// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BanksPanel, BankLinkRow } from './BudgetImportPage.js';
import { createBankClient, validateAccount, accountLabel, BudgetApiError } from './budget-banks.js';

const noop = () => {};
const link = { id: 'l1', institution: '<b>Bank</b>', status: 'needs_login' as const, lastError: null, lastSyncedAt: null, accounts: ['Chequing'] };

describe('BanksPanel', () => {
  it('says Plaid is not set up and hides Connect', () => {
    const html = renderToStaticMarkup(<BanksPanel state={{ configured: false, links: [] }} busy={false} message={null} onSyncAll={noop} onSync={noop} onDisconnect={noop} />);
    expect(html).toContain('Plaid not set up');
    expect(html).not.toContain('Connect a bank');
  });
  it('offers Connect when configured', () => {
    const html = renderToStaticMarkup(<BanksPanel state={{ configured: true, links: [] }} busy={false} message={null} onSyncAll={noop} onSync={noop} onDisconnect={noop} />);
    expect(html).toContain('href="/budget/connect-bank"');
    expect(html).toContain('Connect a bank');
  });
});

describe('BankLinkRow', () => {
  const html = renderToStaticMarkup(<BankLinkRow link={link} busy={false} onSync={noop} onDisconnect={noop} />);
  it('shows Reconnect with a words-based status and escapes the bank name', () => {
    expect(html).toContain('Needs login');
    expect(html).toContain('Reconnect');
    expect(html).toContain('href="/budget/connect-bank"');
    expect(html).toContain('&lt;b&gt;Bank');
    expect(html).not.toContain('<b>Bank');
  });
  it('does not disconnect without a confirm step', () => {
    expect(html).not.toContain('Yes, disconnect');
  });
});

describe('bank client', () => {
  it('sends the file raw with name and account in the query', async () => {
    let seen: { path: string; init?: RequestInit } | null = null;
    const c = createBankClient(async (path, init) => { seen = { path, init }; return new Response(JSON.stringify({ added: 1, duplicates: 0, skipped: 0, format: 'qbo' })); });
    const r = await c.importFile(new File(['x'], 'a b.qbo'), ' Chequing ');
    expect(r.added).toBe(1);
    expect(seen!.path).toBe('/api/budget/imports?name=a+b.qbo&account=Chequing');
    expect((seen!.init!.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
  });
  it('turns 401 into a locked error and surfaces server messages', async () => {
    const c = createBankClient(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 }));
    await expect(c.banks()).rejects.toMatchObject({ locked: true, message: 'nope' });
    expect(new BudgetApiError('x', 500).locked).toBe(false);
  });
  it('validates the account label and formats accounts', () => {
    expect(validateAccount('  ')).not.toBeNull();
    expect(validateAccount('Chequing')).toBeNull();
    expect(accountLabel({ name: 'Joint', mask: '1234' })).toBe('Joint …1234');
  });
});
