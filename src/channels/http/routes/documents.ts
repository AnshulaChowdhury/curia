// documents.ts — console Memory → Documents API (#1821).
//
// Browse, view, search and download the OKF working-document store. Same CEO-only
// curia_session auth as the KG routes. Every read goes through WorkingDocsRepo — no SQL
// against working_documents lives here.
//
// The store holds sensitive personal content (medical prep, travel and family logistics),
// so these routes are only mounted when the bootstrap secret is configured.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { WorkingDocRow, WorkingDocsRepo, WorkingDocStatusFilter } from '../../../db/working-docs-repo.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';
import {
  attachmentDisposition,
  documentMatches,
  downloadFilename,
  renderBodyChunks,
  toSummaryJson,
} from '../documents-view.js';

export interface DocumentsRouteOptions {
  workingDocs: WorkingDocsRepo;
  logger: Logger;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  /** Configured `documentWorkspace.scratchTtlDays` — drives the derived scratch expiry. */
  scratchTtlDays: number;
}

const STATUS_VALUES = new Set<WorkingDocStatusFilter>(['live', 'archived', 'all']);
const MAX_QUERY_LENGTH = 200;
const MAX_PATH_LENGTH = 1024;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

type Query = Record<string, string | undefined>;

function parseStatus(raw: string | undefined): WorkingDocStatusFilter | null {
  if (raw === undefined || raw === '') return 'live';
  return STATUS_VALUES.has(raw as WorkingDocStatusFilter) ? raw as WorkingDocStatusFilter : null;
}

function parseIntInRange(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n < min || n > max ? null : n;
}

function parsePrefix(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return '/';
  if (raw.length > MAX_PATH_LENGTH || !raw.startsWith('/')) return null;
  return raw;
}

export async function documentsRoutes(
  app: FastifyInstance,
  options: DocumentsRouteOptions,
): Promise<void> {
  const { workingDocs, logger, webAppBootstrapSecret, sessions, scratchTtlDays } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // Reads only. Generous enough for a page that lists, opens and searches as you type.
  const READ_RATE = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  /**
   * Resolve `?id=` (any row, live or archived) or `?path=` (the live document at that
   * path). Sends the error reply itself and returns null when the target is invalid
   * or missing.
   */
  async function resolveDocument(query: Query, reply: FastifyReply): Promise<WorkingDocRow | null> {
    const { id, path } = query;
    if (id !== undefined && id !== '') {
      if (!isUuid(id)) {
        void reply.status(400).send({ error: 'id must be a UUID' });
        return null;
      }
      const doc = await workingDocs.readById(id);
      if (!doc) void reply.status(404).send({ error: 'Document not found' });
      return doc;
    }
    if (path === undefined || path === '' || path.length > MAX_PATH_LENGTH || !path.startsWith('/')) {
      void reply.status(400).send({ error: 'Provide an absolute document path or an id' });
      return null;
    }
    const doc = await workingDocs.read(path);
    if (!doc) void reply.status(404).send({ error: 'No live document at that path' });
    return doc;
  }

  // -- GET /api/documents — the store as a flat list (no bodies); the console builds the tree --

  app.get('/api/documents', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const query = request.query as Query;
    const status = parseStatus(query.status);
    const prefix = parsePrefix(query.prefix);
    if (!status) return reply.status(400).send({ error: 'status must be live, archived or all' });
    if (!prefix) return reply.status(400).send({ error: 'prefix must be an absolute path' });
    const type = query.type !== undefined && query.type !== '' ? query.type : undefined;

    try {
      const summaries = await workingDocs.listSummaries({ prefix, status });
      // Types are counted before the type filter so the filter control can offer them all.
      const typeCounts = new Map<string, number>();
      for (const doc of summaries) typeCounts.set(doc.type, (typeCounts.get(doc.type) ?? 0) + 1);
      const documents = (type === undefined ? summaries : summaries.filter(d => d.type === type))
        .map(d => toSummaryJson(d, scratchTtlDays));
      return reply.send({
        documents,
        types: [...typeCounts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        scratchTtlDays,
      });
    } catch (err) {
      logger.error({ err, prefix, status }, 'GET /api/documents: list failed');
      return reply.status(500).send({ error: 'Failed to list documents' });
    }
  });

  // -- GET /api/documents/doc — one document: metadata, frontmatter, body, rendered chunks, backlinks --

  app.get('/api/documents/doc', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const query = request.query as Query;
    try {
      const doc = await resolveDocument(query, reply);
      if (!doc) return;
      // Backlinks are path-keyed and join on live sources, so they are meaningful for the
      // live document at a path; an archived row shows none rather than another row's.
      const backlinks = doc.archivedAt === null ? await workingDocs.getBacklinks(doc.path) : [];
      return reply.send({
        document: {
          ...toSummaryJson(doc, scratchTtlDays),
          frontmatter: doc.frontmatter,
          body: doc.body,
        },
        htmlChunks: renderBodyChunks(doc.body),
        backlinks: backlinks.map(l => ({ sourcePath: l.sourcePath, linkKind: l.linkKind })),
      });
    } catch (err) {
      logger.error({ err, path: query.path, id: query.id }, 'GET /api/documents/doc: read failed');
      return reply.status(500).send({ error: 'Failed to read document' });
    }
  });

  // -- GET /api/documents/search — case-insensitive substring search over paths and bodies --

  app.get('/api/documents/search', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const query = request.query as Query;
    const q = (query.q ?? '').trim();
    const status = parseStatus(query.status);
    const prefix = parsePrefix(query.prefix);
    const offset = parseIntInRange(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = parseIntInRange(query.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    if (q === '' || q.length > MAX_QUERY_LENGTH) {
      return reply.status(400).send({ error: `q must be 1–${MAX_QUERY_LENGTH} characters` });
    }
    if (!status) return reply.status(400).send({ error: 'status must be live, archived or all' });
    if (!prefix) return reply.status(400).send({ error: 'prefix must be an absolute path' });
    if (offset === null || limit === null) {
      return reply.status(400).send({ error: `offset must be ≥ 0 and limit 1–${MAX_SEARCH_LIMIT}` });
    }

    try {
      const docs = await workingDocs.searchText(q, { prefix, status });
      const matches = docs.flatMap(doc => documentMatches(doc, q));
      return reply.send({
        query: q,
        total: matches.length,
        documentCount: docs.length,
        offset,
        limit,
        matches: matches.slice(offset, offset + limit),
      });
    } catch (err) {
      logger.error({ err, prefix, status }, 'GET /api/documents/search: search failed');
      return reply.status(500).send({ error: 'Search failed' });
    }
  });

  // -- GET /api/documents/download — one document as an OKF file --

  app.get('/api/documents/download', READ_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const query = request.query as Query;
    try {
      const doc = await resolveDocument(query, reply);
      if (!doc) return;
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', attachmentDisposition(downloadFilename(doc.path, doc.version, doc.id)))
        .header('Cache-Control', 'no-store')
        .send(workingDocs.toOkf(doc));
    } catch (err) {
      logger.error({ err, path: query.path, id: query.id }, 'GET /api/documents/download: read failed');
      return reply.status(500).send({ error: 'Failed to download document' });
    }
  });
}
