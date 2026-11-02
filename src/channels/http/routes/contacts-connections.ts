// contacts-connections.ts — the contacts cards on Settings → API connections.
//
//   GET  /api/connections/matrix-bridges            — each bridge's address and whether a secret is saved (never the secret)
//   PUT  /api/connections/matrix-bridges/:id        — save a bridge's address and/or provisioning secret to the vault
//   POST /api/connections/matrix-bridges/:id/test   — one read-only check: who is logged in, how many contacts (counts only)
//   GET  /api/connections/contacts-import           — whether the Mac mini's import token exists
//   POST /api/connections/contacts-import-token     — make a new import token, shown once
//
// Session auth like the other console routes. Vault names come from the fixed table in contacts-import/bridges.ts,
// so no request can write an arbitrary key. Secrets are write-only: no response or log ever contains one.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { SecretsService } from '../../../secrets/secrets-service.js';
import {
  BRIDGES, MAX_BRIDGE_SECRET, bridgeUrlProblem, bridgeVaultKeys, findBridge, suggestedBridgeUrl, testBridge,
} from '../../../contacts-import/bridges.js';
import type { ContactsImportToken } from '../../../contacts-import/import-token.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface ContactsConnectionsRouteOptions {
  logger: Logger;
  secrets: Pick<SecretsService, 'get' | 'set' | 'delete'>;
  importToken: ContactsImportToken;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  fetchImpl?: typeof fetch;
}

interface PutBody {
  /** "" clears the address. */
  url?: unknown;
  /** Omitted = keep the stored secret; "" = clear it; otherwise replace it. */
  secret?: unknown;
}

export async function contactsConnectionsRoutes(app: FastifyInstance, options: ContactsConnectionsRouteOptions): Promise<void> {
  const { logger, secrets, importToken, webAppBootstrapSecret, sessions, fetchImpl = fetch } = options;
  const RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const WRITE_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const TEST_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const read = async (key: string): Promise<string> => (await secrets.get(key))?.trim() ?? '';

  async function snapshotOf(bridge: (typeof BRIDGES)[number]) {
    const k = bridgeVaultKeys(bridge.id);
    return {
      id: bridge.id,
      label: bridge.label,
      url: await read(k.url),
      suggestedUrl: suggestedBridgeUrl(bridge),
      hasSecret: (await read(k.secret)) !== '',
    };
  }

  app.get('/api/connections/matrix-bridges', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const bridges = [];
    for (const b of BRIDGES) bridges.push(await snapshotOf(b));
    return reply.header('Cache-Control', 'no-store').send({ bridges });
  });

  app.put<{ Params: { id: string }; Body: PutBody }>('/api/connections/matrix-bridges/:id', WRITE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const bridge = findBridge(request.params.id);
    if (!bridge) return reply.status(404).send({ error: 'Unknown bridge' });
    const b = request.body ?? {};
    const bad = (error: string) => reply.status(400).send({ error });

    if (b.url !== undefined) {
      if (typeof b.url !== 'string') return bad('address must be text');
      const trimmed = b.url.trim();
      const problem = trimmed === '' ? null : bridgeUrlProblem(trimmed);
      if (problem) return bad(problem);
    }
    if (b.secret !== undefined && (typeof b.secret !== 'string' || b.secret.length > MAX_BRIDGE_SECRET)) {
      return bad('secret must be text of at most 512 characters');
    }

    const k = bridgeVaultKeys(bridge.id);
    if (typeof b.url === 'string') {
      const trimmed = b.url.trim();
      if (trimmed === '') await secrets.delete(k.url);
      else await secrets.set(k.url, trimmed);
    }
    if (typeof b.secret === 'string') {
      if (b.secret === '') await secrets.delete(k.secret);
      else await secrets.set(k.secret, b.secret.trim());
    }
    // Field names only; never values.
    logger.info({ bridge: bridge.id, fields: Object.keys(b) }, 'matrix-bridges: connection saved');
    return reply.header('Cache-Control', 'no-store').send(await snapshotOf(bridge));
  });

  app.post<{ Params: { id: string } }>('/api/connections/matrix-bridges/:id/test', TEST_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const bridge = findBridge(request.params.id);
    if (!bridge) return reply.status(404).send({ error: 'Unknown bridge' });
    const k = bridgeVaultKeys(bridge.id);
    const [url, secret] = [await read(k.url), await read(k.secret)];
    if (!url || !secret) return reply.status(400).send({ error: 'Save the address and the secret first.' });
    // Re-check the saved address: the secret must never be sent to a public host, even if the vault was edited elsewhere.
    const problem = bridgeUrlProblem(url);
    if (problem) return reply.status(400).send({ error: `Saved address is not allowed: ${problem}` });

    const result = await testBridge(url, secret, logger, fetchImpl);
    logger.info({ bridge: bridge.id, ok: result.ok, contacts: result.contacts }, 'matrix-bridges: test run');
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  app.get('/api/connections/contacts-import', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send({ tokenSet: await importToken.isSet() });
  });

  app.post('/api/connections/contacts-import-token', WRITE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const token = await importToken.generate();
    logger.info('contacts-import: a new import token was made');
    // Shown once: only its hash is kept.
    return reply.header('Cache-Control', 'no-store').send({ token });
  });
}
