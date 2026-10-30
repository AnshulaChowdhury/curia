// legacy-kg-aliases.ts — one-release 308 redirects from historical /api/kg/*
// console paths to their /api/* homes (#872 review).
//
// A console tab left open across a deploy keeps the old bundle and keeps calling
// /api/kg/{tasks,contacts,chat,grant-recommendations}. Without these aliases,
// GETs fall into the SPA /* catch-all and look like a broken session. Remove
// after one release once stale clients have recycled.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Omit HEAD — Fastify derives it from GET and rejects a second declaration.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function querySuffix(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? '' : url.slice(i);
}

function bounce(to: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.redirect(`${to}${querySuffix(request.url)}`, 308);
  };
}

/**
 * Register exact + wildcard 308 aliases for each moved prefix.
 * Mounted under the same webAppBootstrapSecret gate as the new routes; the
 * paths still sit under /api/kg so SELF_AUTHED_API_PREFIXES already covers them.
 */
export async function legacyKgAliasRoutes(app: FastifyInstance): Promise<void> {
  const aliases: Array<{ from: string; to: string }> = [
    { from: '/api/kg/tasks', to: '/api/tasks' },
    { from: '/api/kg/contacts', to: '/api/contacts' },
    { from: '/api/kg/chat', to: '/api/chat' },
    { from: '/api/kg/grant-recommendations', to: '/api/grant-recommendations' },
  ];

  for (const { from, to } of aliases) {
    for (const method of METHODS) {
      app.route({ method, url: from, handler: bounce(to) });
      app.route({
        method,
        url: `${from}/*`,
        handler: async (request, reply) => {
          const rest = (request.params as Record<string, string>)['*'] ?? '';
          return reply.redirect(`${to}/${rest}${querySuffix(request.url)}`, 308);
        },
      });
    }
  }
}
