// inbox-triage.ts — the Inbox triage form on Settings → API connections.
//
//   GET  /api/connections/inbox-triage       — current settings (never the ntfy token) + whether the watcher is running
//   PUT  /api/connections/inbox-triage       — save settings to the encrypted vault, then restart the watcher
//   POST /api/connections/inbox-triage/test  — send one content-free test push with the saved ntfy settings
//
// Session auth like the other console routes. Values are written to the vault under fixed `inbox_triage_*` names only;
// the ntfy token is write-only (the form can replace or clear it, never read it back).

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { SecretsService } from '../../../secrets/secrets-service.js';
import type { InboxTriageController } from '../../../inbox-triage/controller.js';
import { TRIAGE_SECRET_KEYS as K } from '../../../inbox-triage/start.js';
import { NtfyNotifier } from '../../../inbox-triage/ntfy-notifier.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface InboxTriageRouteOptions {
  logger: Logger;
  secrets: Pick<SecretsService, 'get' | 'set' | 'delete'>;
  controller: Pick<InboxTriageController, 'reload' | 'status'>;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  fetchImpl?: typeof fetch;
}

interface PutBody {
  enabled?: unknown;
  ntfyUrl?: unknown;
  /** Omitted = keep the stored token; "" = clear it; otherwise replace it. */
  ntfyToken?: unknown;
  minConfidence?: unknown;
}

const MAX_TOKEN = 512;

/** An http(s) topic address with a topic in the path and no embedded credentials. */
function validTopicUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export async function inboxTriageRoutes(app: FastifyInstance, options: InboxTriageRouteOptions): Promise<void> {
  const { logger, secrets, controller, webAppBootstrapSecret, sessions, fetchImpl = fetch } = options;
  const RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const TEST_RATE = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

  const read = async (key: string): Promise<string> => (await secrets.get(key))?.trim() ?? '';

  async function snapshot() {
    const confidence = Number(await read(K.minConfidence));
    return {
      enabled: (await read(K.enabled)).toLowerCase() === 'true',
      ntfyUrl: await read(K.ntfyUrl),
      hasToken: (await read(K.ntfyToken)) !== '',
      minConfidence: Number.isFinite(confidence) && confidence > 0 && confidence <= 1 ? confidence : null,
      nylasConfigured: (await read('nylas_api_key')) !== '',
      ...controller.status(),
    };
  }

  app.get('/api/connections/inbox-triage', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    return reply.header('Cache-Control', 'no-store').send(await snapshot());
  });

  app.put<{ Body: PutBody }>('/api/connections/inbox-triage', RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const b = request.body ?? {};
    const bad = (error: string) => reply.status(400).send({ error });

    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return bad('enabled must be true or false');
    if (b.ntfyUrl !== undefined && (typeof b.ntfyUrl !== 'string' || (b.ntfyUrl.trim() !== '' && !validTopicUrl(b.ntfyUrl.trim())))) {
      return bad('ntfy address must be an http(s) topic address like https://ntfy.example.com/curia-mail, without a username or password');
    }
    if (b.ntfyToken !== undefined && (typeof b.ntfyToken !== 'string' || b.ntfyToken.length > MAX_TOKEN)) {
      return bad('token is too long');
    }
    if (b.minConfidence !== undefined && b.minConfidence !== null
        && (typeof b.minConfidence !== 'number' || !(b.minConfidence > 0 && b.minConfidence <= 1))) {
      return bad('confidence must be above 0 and at most 1');
    }

    if (b.enabled !== undefined) await secrets.set(K.enabled, b.enabled ? 'true' : 'false');
    if (typeof b.ntfyUrl === 'string') await secrets.set(K.ntfyUrl, b.ntfyUrl.trim());
    if (typeof b.ntfyToken === 'string') {
      if (b.ntfyToken === '') await secrets.delete(K.ntfyToken);
      else await secrets.set(K.ntfyToken, b.ntfyToken);
    }
    if (b.minConfidence === null) await secrets.delete(K.minConfidence);
    else if (typeof b.minConfidence === 'number') await secrets.set(K.minConfidence, String(b.minConfidence));

    try {
      await controller.reload();
    } catch (err) {
      // Saved, but the watcher did not come up; say so rather than pretending it is running.
      logger.error({ err }, 'inbox-triage: restart after settings save failed');
      return reply.status(500).send({ error: 'Saved, but the watcher could not start. Check the server log.' });
    }
    logger.info({ enabled: b.enabled, fields: Object.keys(b) }, 'inbox-triage: settings saved');
    return reply.header('Cache-Control', 'no-store').send(await snapshot());
  });

  app.post('/api/connections/inbox-triage/test', TEST_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const url = await read(K.ntfyUrl);
    if (!url) return reply.status(400).send({ error: 'Save the ntfy address first.' });
    try {
      await new NtfyNotifier(url, (await read(K.ntfyToken)) || null, fetchImpl).notify('seen');
      return reply.send({ ok: true });
    } catch (err) {
      // The notifier's message carries the HTTP status only; never echo the URL or token.
      logger.warn({ err }, 'inbox-triage: test push failed');
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'Push failed' });
    }
  });
}
