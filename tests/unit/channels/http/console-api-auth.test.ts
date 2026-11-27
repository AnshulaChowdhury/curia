// The console signs in with a session cookie. A route family it calls that is missing from the self-authed list is
// refused by the adapter's bearer-token hook, which route tests never run (the budget pages shipped "Locked" this way).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { bypassesBearerAuth } from '../../../../src/channels/http/auth.js';
import { budgetRoutes } from '../../../../src/channels/http/routes/budget.js';
import { budgetBanksRoutes } from '../../../../src/channels/http/routes/budget-banks.js';
import { budgetAccountsRoutes } from '../../../../src/channels/http/routes/budget-accounts.js';
import { budgetSheetsRoutes } from '../../../../src/channels/http/routes/budget-sheets.js';
import type { Logger } from '../../../../src/logger.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';

const CONSOLE_SRC = fileURLToPath(new URL('../../../../apps/console/src/', import.meta.url));

describe('console API authentication', () => {
  it('lets every /api family the console calls reach its own session check', () => {
    const families = new Set<string>();
    for (const file of readdirSync(CONSOLE_SRC, { recursive: true, encoding: 'utf8' })) {
      if (!/(?<!\.test)\.tsx?$/.test(file) || file.split('/').pop()!.startsWith('._')) continue;
      for (const m of readFileSync(CONSOLE_SRC + file, 'utf8').matchAll(/['"`](\/api\/[a-z0-9-]+)/g)) families.add(m[1]!);
    }
    expect(families).toContain('/api/budget');
    expect([...families].filter(f => !bypassesBearerAuth(f))).toEqual([]);
  });

  // Skipping the bearer check is only safe because each of these routes refuses on its own.
  it('has every budget route refuse a request with no session', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const app = Fastify();
    const routes: Array<{ method: string; url: string }> = [];
    app.addHook('onRoute', r => {
      for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push({ method, url: r.url });
    });
    const shared = { logger, webAppBootstrapSecret: 'a-long-bootstrap-secret-for-tests-0123456789', sessions: new Map() as SessionStore };
    await app.register(budgetRoutes, { ...shared, store: {} as never });
    await app.register(budgetBanksRoutes, { ...shared, sync: {} as never, plaid: {} as never });
    await app.register(budgetAccountsRoutes, { ...shared, accounts: {} as never });
    await app.register(budgetSheetsRoutes, { ...shared, sheets: {} as never });
    await app.ready();

    expect(routes.length).toBeGreaterThanOrEqual(28);
    for (const { method, url } of routes) {
      expect(bypassesBearerAuth(url), url).toBe(true);
      const res = await app.inject({
        method: method as 'GET',
        url: url.replace(':id', '11111111-1111-4111-8111-111111111111'),
        ...(url === '/api/budget/imports' ? { headers: { 'content-type': 'application/octet-stream' }, payload: 'x' } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
