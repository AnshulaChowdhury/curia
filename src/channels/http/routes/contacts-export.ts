// contacts-export.ts — the Matrix exporter on the Mac mini talks to Curia here. Outbound from the mini only.
//
//   Bearer: the contacts import token (Settings → API connections). 404 until one exists. These routes reach nothing else.
//     GET  /contacts/export/ping           the job's own check: proves the token works
//     GET  /contacts/export/run-request    the open run (200 { runId, since, doneRooms }) or 204 when nothing is asked
//     POST /contacts/export/rooms          { runId, rooms: [...] } counts per room; idempotent, marks rooms done
//     POST /contacts/export/log            { runId?, lines: [{ level, message }] }  the job's status lines (no message text)
//     POST /contacts/export/finish         { runId, status: 'done' | 'failed', errorKind? }
//   Session (the console):
//     POST /api/contacts/export/request    ask for a run (ten years back)
//     GET  /api/contacts/export/status     the latest run and how many partner rows are stored
//
// What is accepted is strict (export-validate.ts): counts, a display name, a phone, two dates. Never message text.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { ContactsImportToken } from '../../../contacts-import/import-token.js';
import type { ExportStore } from '../../../contacts-import/export-store.js';
import { parseLog, parseRooms } from '../../../contacts-import/export-validate.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export const EXPORT_YEARS = 10;
const RUN_ID_RX = /^exp-[a-z0-9]+-[0-9a-f]{8}$/;

export interface ContactsExportRouteOptions {
  logger: Logger;
  store: ExportStore;
  importToken: ContactsImportToken;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  now?: () => number;
}

export async function contactsExportRoutes(app: FastifyInstance, options: ContactsExportRouteOptions): Promise<void> {
  const { logger, store, importToken, webAppBootstrapSecret, sessions, now = Date.now } = options;
  const RATE = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  const tokenOk = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const ok = await importToken.verify(provided);
    if (ok === null) { void reply.status(404).send({ error: 'Not found' }); return false; }
    if (!provided || !ok) {
      logger.warn({ ip: request.ip, reason: provided ? 'invalid_token' : 'missing_token' }, 'contacts-export: auth failed');
      void reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  app.get('/contacts/export/ping', RATE, async (request, reply) => {
    if (!(await tokenOk(request, reply))) return reply;
    return reply.send({ ok: true });
  });

  app.get('/contacts/export/run-request', RATE, async (request, reply) => {
    if (!(await tokenOk(request, reply))) return reply;
    const claimed = await store.claim();
    if (!claimed) return reply.status(204).send();
    return reply.header('Cache-Control', 'no-store').send({ runId: claimed.run.runId, since: claimed.run.since, doneRooms: claimed.doneRooms });
  });

  app.post<{ Body: { runId?: unknown } }>('/contacts/export/rooms', { ...RATE, bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    if (!(await tokenOk(request, reply))) return reply;
    const runId = request.body?.runId;
    if (typeof runId !== 'string' || !RUN_ID_RX.test(runId)) return reply.status(400).send({ error: 'runId is required' });
    const parsed = parseRooms(request.body);
    if (!parsed.ok) return reply.status(400).send({ error: parsed.error });
    if (!(await store.saveRooms(runId, parsed.rooms))) return reply.status(409).send({ error: 'That run is not open.' });
    return reply.send({ saved: parsed.rooms.length });
  });

  app.post('/contacts/export/log', RATE, async (request, reply) => {
    if (!(await tokenOk(request, reply))) return reply;
    const parsed = parseLog(request.body);
    if (!parsed.ok) return reply.status(400).send({ error: parsed.error });
    const runId = (request.body as { runId?: unknown }).runId;
    await store.appendLog(typeof runId === 'string' && RUN_ID_RX.test(runId) ? runId : null, parsed.lines);
    return reply.status(204).send();
  });

  app.post<{ Body: { runId?: unknown; status?: unknown; errorKind?: unknown } }>('/contacts/export/finish', RATE, async (request, reply) => {
    if (!(await tokenOk(request, reply))) return reply;
    const { runId, status, errorKind } = request.body ?? {};
    if (typeof runId !== 'string' || !RUN_ID_RX.test(runId)) return reply.status(400).send({ error: 'runId is required' });
    if (status !== 'done' && status !== 'failed') return reply.status(400).send({ error: "status must be 'done' or 'failed'" });
    const kind = typeof errorKind === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(errorKind) ? errorKind : undefined;
    if (!(await store.finish(runId, status, kind))) return reply.status(409).send({ error: 'That run is not open.' });
    logger.info({ runId, status, errorKind: kind }, 'contacts-export: run finished');
    return reply.send({ ok: true });
  });

  app.post('/api/contacts/export/request', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    if (!(await importToken.isSet())) return reply.status(409).send({ error: 'Make the import token first (Settings → API connections).' });
    const { run, created } = await store.request(new Date(now() - EXPORT_YEARS * 365.25 * 24 * 3600 * 1000));
    return reply.status(created ? 202 : 200).send({ runId: run.runId, created });
  });

  app.get('/api/contacts/export/status', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return reply;
    const run = await store.latest();
    return reply.header('Cache-Control', 'no-store').send({
      tokenSet: await importToken.isSet(),
      run: run ? { status: run.status, roomsDone: run.roomsDone, errorKind: run.errorKind, requestedAt: run.requestedAt, finishedAt: run.finishedAt } : null,
      partnerRows: await store.countFacts(),
      log: await store.recentLog(100),
    });
  });
}
