import { describe, it, expect, vi } from 'vitest';
import { InboxTriageController } from '../../../src/inbox-triage/controller.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { EventBus } from '../../../src/bus/bus.js';

// The watcher only polls on a 30s timer, so these runs never reach Nylas; the fake fetch is a guard, not a stub.
function deps(vault: Record<string, string>) {
  return {
    bus: { subscribe: () => {}, publish: async () => {} } as unknown as EventBus,
    fetchImpl: (async () => { throw new Error('no network in this test'); }) as unknown as typeof fetch,
    logger: createSilentLogger(),
    secrets: { get: vi.fn(async (k: string) => vault[k] ?? null) },
    store: undefined,
  };
}

describe('InboxTriageController', () => {
  it('stays stopped while the vault has triage off', async () => {
    const c = new InboxTriageController(deps({}));
    await c.reload();
    expect(c.status()).toEqual({ running: false, accounts: [] });
  });

  it('stays stopped when enabled but no mailbox is connected', async () => {
    const c = new InboxTriageController(deps({ inbox_triage_enabled: 'true', nylas_api_key: 'k' }));
    await c.reload();
    expect(c.status().running).toBe(false);
  });

  it('starts when fully configured, and a reload with the switch off stops it', async () => {
    const vault: Record<string, string> = { inbox_triage_enabled: 'true', nylas_api_key: 'k', phone_inbox_grant_moonray: 'g' };
    const c = new InboxTriageController(deps(vault));
    await c.reload();
    expect(c.status()).toEqual({ running: true, accounts: ['moonray'] });
    vault.inbox_triage_enabled = 'false';
    await c.reload();
    expect(c.status().running).toBe(false);
  });

  it('serialises quick reloads and ends with one watcher', async () => {
    const vault: Record<string, string> = { inbox_triage_enabled: 'true', nylas_api_key: 'k', phone_inbox_grant_moonray: 'g' };
    const c = new InboxTriageController(deps(vault));
    await Promise.all([c.reload(), c.reload(), c.reload()]);
    expect(c.status().running).toBe(true);
    c.stop();
    expect(c.status().running).toBe(false);
  });
});
