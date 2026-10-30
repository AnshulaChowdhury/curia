// legacy-kg-aliases.ts — one-release 308 redirects from historical /api/kg/*
// console paths to their /api/* homes (#872 review).
//
// A console tab left open across a deploy keeps the old bundle and keeps calling
// /api/kg/{tasks,contacts,chat,grant-recommendations}. Without these aliases,
// GETs fall into the SPA /* catch-all and look like a broken session. Remove
// after one release once stale clients have recycled (see CLAUDE.md Preparing a
// release pre-flight).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Omit HEAD — Fastify derives it from GET and rejects a second declaration.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Register exact + wildcard 308 aliases for each moved prefix.
 *
 * Registered only when `webAppBootstrapSecret` is configured (same gate as the
 * new console routes). These handlers do not call `assertSecret` — the target
 * route does. Paths still sit under `/api/kg`, so SELF_AUTHED_API_PREFIXES
 * already covers the redirect hop.
 *
 * Rebuild the Location from `request.url` (raw path + query) rather than the
 * decoded `*` param, so percent-encoding is preserved (#872 review).
 */
export async function legacyKgAliasRoutes(app: FastifyInstance): Promise<void> {
  const aliases: Array<{ from: string; to: string }> = [
    { from: '/api/kg/tasks', to: '/api/tasks' },
    { from: '/api/kg/contacts', to: '/api/contacts' },
    { from: '/api/kg/chat', to: '/api/chat' },
    { from: '/api/kg/grant-recommendations', to: '/api/grant-recommendations' },
  ];

  for (const { from, to } of aliases) {
    const handler = async (request: FastifyRequest, reply: FastifyReply) =>
      reply.redirect(`${to}${request.url.slice(from.length)}`, 308);

    for (const method of METHODS) {
      app.route({ method, url: from, handler });
      app.route({ method, url: `${from}/*`, handler });
    }
  }
}
