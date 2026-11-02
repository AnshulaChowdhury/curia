// phone-brief.ts — GET /phone/brief, the Command Hub morning brief.
//
// Same bearer token as /phone/inbox and /phone/message. Serves the brief the 06:30 job stored for today's local date;
// 204 when there is nothing to report (no brief yet, a failed job, or an empty day). It never serves yesterday's.
// No token in the vault → 404, so the route is invisible until the phone is switched on.
// Contract: contracts/phone-inbox.openapi.yaml in the MVOS repo (path /phone/brief).

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { PhoneBriefService } from '../../../phone-brief/brief-service.js';
import { authorisePhoneRequest } from './phone-auth.js';

export interface PhoneBriefRouteOptions {
  logger: Logger;
  /** The phone's token, read from the vault on each request; null when not configured. */
  getToken: () => Promise<string | null>;
  service: Pick<PhoneBriefService, 'today'>;
  now?: () => number;
}

export async function phoneBriefRoutes(app: FastifyInstance, options: PhoneBriefRouteOptions): Promise<void> {
  const { logger, getToken, service, now = Date.now } = options;

  // The phone asks on Home and every 15 minutes; 30/min leaves room for retries and still blocks guessing.
  app.get('/phone/brief', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await authorisePhoneRequest(request, reply, getToken, logger, 'phone-brief'))) return reply;
    try {
      const brief = await service.today(now());
      if (!brief) return reply.status(204).send();
      // Includes newsletter summaries: keep it out of any shared cache.
      return reply.header('Cache-Control', 'no-store').send(brief);
    } catch (err) {
      logger.error({ err }, 'phone-brief: unexpected failure');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
