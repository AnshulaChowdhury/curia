import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registryRoutes } from '../../../../src/channels/http/routes/registry.js';
import type { RegistryService } from '../../../../src/registry/registry-service.js';
import { RegistryGuardError } from '../../../../src/registry/types.js';

const SECRET = 'test-bootstrap-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET };

describe('registry routes: enabling an agent with its bundles', () => {
  const entry = { name: 'books', kind: 'agent', state: 'enabled' };
  const svc = {
    enable: vi.fn().mockResolvedValue(entry),
    installAndEnable: vi.fn().mockResolvedValue(entry),
    install: vi.fn().mockResolvedValue(entry),
  } as unknown as RegistryService;
  const app = Fastify();

  beforeAll(async () => {
    await app.register(cookie);
    await app.register(registryRoutes, { registryService: svc, webAppBootstrapSecret: SECRET, sessions: new Map() });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it('passes ?with_bundles=true through, and only when it is exactly true', async () => {
    await app.inject({ method: 'POST', url: '/api/registry/agents/books/enable?with_bundles=true', headers: AUTH });
    expect(svc.enable).toHaveBeenLastCalledWith('agent', 'books', 'web-app', { withBundles: true });
    for (const q of ['', '?with_bundles=false', '?with_bundles=1', '?with_bundles=yes']) {
      await app.inject({ method: 'POST', url: `/api/registry/agents/books/enable${q}`, headers: AUTH });
      expect(svc.enable).toHaveBeenLastCalledWith('agent', 'books', 'web-app', { withBundles: false });
    }
  });

  it('does the same for install-enable', async () => {
    await app.inject({ method: 'POST', url: '/api/registry/agents/books/install-enable?with_bundles=true', headers: AUTH });
    expect(svc.installAndEnable).toHaveBeenLastCalledWith('agent', 'books', 'web-app', { withBundles: true });
  });

  it('answers a bundle that cannot be enabled with a 400 and its message', async () => {
    vi.mocked(svc.enable).mockRejectedValueOnce(new RegistryGuardError("Cannot enable 'books': its skill bundle 'books' could not be enabled: x"));
    const res = await app.inject({ method: 'POST', url: '/api/registry/agents/books/enable?with_bundles=true', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("skill bundle 'books'");
  });

  it('refuses without the secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/registry/agents/books/enable?with_bundles=true' });
    expect(res.statusCode).toBe(401);
  });
});
