// documents.ts — console Memory → Documents API (#1821, #1822).
//
// Browse, view, search and download the OKF working-document store, and edit it: whole-
// document saves through WorkingDocsRepo.update's optimistic concurrency, create, archive
// (soft-delete) and restore. Same CEO-only curia_session auth as the KG routes. Every
// read and write goes through WorkingDocsRepo — no SQL against working_documents lives
// here.
//
// Every mutation is audited write-ahead (a `requested` document.console_action event
// before the store is touched; refused if it can't be recorded), then appends to the
// directory's log.md the way doc-write does, stamps the principal's edit into the
// frontmatter, and publishes a `completed` event.
//
// The store holds sensitive personal content (medical prep, travel and family logistics),
// so these routes are only mounted when the bootstrap secret is configured.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { EventBus } from '../../../bus/bus.js';
import { createDocumentConsoleAction } from '../../../bus/events.js';
import type { WorkingDocRow, WorkingDocsRepo, WorkingDocStatusFilter } from '../../../db/working-docs-repo.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { isUuid } from '../../../util/uuid.js';
import { normalizeDocPath, okfByteSize, parseOkfDocument } from '../../../memory/okf.js';
import {
  appendDirectoryLogEntry,
  LOG_FILENAME,
  PRINCIPAL_EDIT_STAMP_KEY,
  RESERVED_LEAF_NAMES,
} from '../../../agents/document-workspace.js';
import { CONSOLE_CHANNEL } from '../console-originator.js';
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
  /** Configured `documentWorkspace.consoleEditMaxBytes` — larger documents are read-only here. */
  editMaxBytes: number;
  /** Audit sink for document.console_action events. */
  bus: Pick<EventBus, 'publish'>;
}

type ConsoleAction = 'create' | 'update' | 'archive' | 'restore';

/** Editor content parsed into the store's parts; `type` lives in its own column. */
interface ParsedEditorContent {
  type: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseEditorContent(content: string): ParsedEditorContent | { error: string } {
  try {
    const parsed = parseOkfDocument(content);
    const { type: _type, ...frontmatter } = parsed.frontmatter;
    void _type;
    return { type: parsed.type.trim(), frontmatter, body: parsed.body };
  } catch (err) {
    return { error: `Not a valid OKF document: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A console write records that the principal made it — visible to any agent that reads the document. */
function stampPrincipalEdit(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return { ...frontmatter, [PRINCIPAL_EDIT_STAMP_KEY]: new Date().toISOString() };
}

/** Validate a client-supplied document path for create: absolute, `.md`, not the root. */
function parseDocPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH || !raw.startsWith('/')) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const normalized = normalizeDocPath(raw);
  return normalized !== '/' && normalized.endsWith('.md') ? normalized : null;
}

function leafOf(path: string): string {
  return path.split('/').pop() ?? path;
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
  const { workingDocs, logger, webAppBootstrapSecret, sessions, scratchTtlDays, editMaxBytes, bus } = options;

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

  /** The single-document payload shared by GET /doc and every mutation response. */
  async function detailJson(doc: WorkingDocRow) {
    // Backlinks are path-keyed and join on live sources, so they are meaningful for the
    // live document at a path; an archived row shows none rather than another row's.
    const backlinks = doc.archivedAt === null ? await workingDocs.getBacklinks(doc.path) : [];
    const editable = doc.archivedAt === null && doc.byteSize <= editMaxBytes;
    return {
      document: {
        ...toSummaryJson(doc, scratchTtlDays),
        frontmatter: doc.frontmatter,
        body: doc.body,
      },
      htmlChunks: renderBodyChunks(doc.body),
      backlinks: backlinks.map(l => ({ sourcePath: l.sourcePath, linkKind: l.linkKind })),
      editable,
      editMaxBytes,
      // The editor works on the whole serialized document, frontmatter included.
      okf: editable ? workingDocs.toOkf(doc) : null,
    };
  }

  /**
   * Write-ahead audit: durably record that the principal asked for a change BEFORE the
   * store is touched. If the record can't be written the change is refused — a mutation
   * must never exist without an audit row. Sends the 500 itself and returns false.
   */
  async function auditRequested(
    action: ConsoleAction,
    target: { path: string; documentId: string | null; baseVersion: number | null; byteSize: number | null },
    reply: FastifyReply,
  ): Promise<boolean> {
    try {
      await bus.publish('system', createDocumentConsoleAction({
        stage: 'requested',
        action,
        ...target,
        initiatedBy: 'principal',
        channel: CONSOLE_CHANNEL,
      }));
      return true;
    } catch (err) {
      logger.error({ err, action, path: target.path }, 'console documents: audit write failed — change refused');
      void reply.status(500).send({
        error: 'Nothing was changed: the change could not be audited, so it was not made. Check the server logs.',
      });
      return false;
    }
  }

  /**
   * After a successful write: the log.md line in the document's directory (except for
   * log.md itself, which would log into the file being changed — or recreate an archived
   * one) and the `completed` audit event. The change is already made and already audited
   * as requested, so a miss here comes back as a warning on a successful response rather
   * than an error that would invite retrying a change that happened.
   */
  async function recordCompleted(action: ConsoleAction, doc: WorkingDocRow): Promise<string[]> {
    const warnings: string[] = [];
    if (leafOf(doc.path) !== LOG_FILENAME) {
      const logged = await appendDirectoryLogEntry(workingDocs, logger, {
        documentPath: doc.path,
        operation: `console-${action}`,
        summary: `principal ${action === 'update' ? 'edited' : `${action}d`} ${leafOf(doc.path)} in the console`,
        source: 'console documents',
      });
      if (!logged) warnings.push(`The change was made, but its entry in ${LOG_FILENAME} could not be written.`);
    }
    try {
      await bus.publish('system', createDocumentConsoleAction({
        stage: 'completed',
        action,
        path: doc.path,
        documentId: doc.id,
        version: doc.version,
        byteSize: doc.byteSize,
        initiatedBy: 'principal',
        channel: CONSOLE_CHANNEL,
      }));
    } catch (err) {
      logger.error({ err, action, path: doc.path }, 'console documents: completed audit event failed after the change was made');
      warnings.push('The change was made and its request was audited, but the completion audit entry failed — check the server logs.');
    }
    return warnings;
  }

  /**
   * Authenticate in onRequest, before Fastify reads and parses the body — an
   * unauthenticated client must not get a large body buffered before its 401.
   */
  async function authBeforeBody(request: FastifyRequest, reply: FastifyReply) {
    if (!requireAuth(request, reply)) return reply;
  }

  // Writes are rarer than reads. JSON escaping can grow a body up to 6× (\uXXXX), so the
  // save routes size their body limit from the cap instead of the 64 KiB app default.
  const WRITE_ROUTE = {
    bodyLimit: editMaxBytes * 6 + 16 * 1024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    onRequest: authBeforeBody,
  };

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
      return reply.send(await detailJson(doc));
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

  // -- POST /api/documents/doc — create a document from OKF text at a new path --

  app.post('/api/documents/doc', WRITE_ROUTE, async (request, reply) => {
    const body = request.body as { path?: unknown; content?: unknown } | undefined;
    const path = parseDocPath(body?.path);
    if (!path) return reply.status(400).send({ error: 'path must be an absolute .md document path' });
    if (RESERVED_LEAF_NAMES.has(leafOf(path))) {
      return reply.status(400).send({
        error: `${leafOf(path)} is reserved — log.md is appended automatically and index.md is a projection`,
        reason: 'reserved',
      });
    }
    if (typeof body?.content !== 'string') return reply.status(400).send({ error: 'content (OKF text) is required' });
    const parsed = parseEditorContent(body.content);
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error });
    const frontmatter = stampPrincipalEdit(parsed.frontmatter);
    const size = okfByteSize({ type: parsed.type, frontmatter, body: parsed.body });
    if (size > editMaxBytes) {
      return reply.status(413).send({ error: `Document would be ${size} bytes — over the ${editMaxBytes}-byte console limit`, reason: 'over_cap' });
    }

    try {
      if (await workingDocs.livePathExists(path)) {
        return reply.status(409).send({ error: `A live document already exists at ${path}`, reason: 'exists' });
      }
      if (!(await auditRequested('create', { path, documentId: null, baseVersion: null, byteSize: size }, reply))) return;
      let created: WorkingDocRow;
      try {
        created = await workingDocs.create({ path, type: parsed.type, frontmatter, body: parsed.body });
      } catch (err) {
        // 23505: created concurrently between the existence check and the insert.
        if ((err as { code?: string }).code === '23505') {
          return reply.status(409).send({ error: `A live document already exists at ${path}`, reason: 'exists' });
        }
        throw err;
      }
      const warnings = await recordCompleted('create', created);
      return reply.status(201).send({ ...(await detailJson(created)), warnings });
    } catch (err) {
      logger.error({ err, path }, 'POST /api/documents/doc: create failed');
      return reply.status(500).send({ error: 'Failed to create document' });
    }
  });

  // -- PUT /api/documents/doc — whole-document save with optimistic concurrency --

  app.put('/api/documents/doc', WRITE_ROUTE, async (request, reply) => {
    const body = request.body as { path?: unknown; content?: unknown; expectedVersion?: unknown } | undefined;
    const path = parseDocPath(body?.path);
    if (!path) return reply.status(400).send({ error: 'path must be an absolute .md document path' });
    if (typeof body?.content !== 'string') return reply.status(400).send({ error: 'content (OKF text) is required' });
    const expectedVersion = body.expectedVersion;
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return reply.status(400).send({ error: 'expectedVersion (the version you loaded) is required' });
    }

    try {
      const current = await workingDocs.read(path);
      if (!current) return reply.status(404).send({ error: 'No live document at that path' });
      if (current.byteSize > editMaxBytes) {
        return reply.status(403).send({
          error: `This document is ${current.byteSize} bytes — over the ${editMaxBytes}-byte console limit, so it is read-only here. Download it to edit offline.`,
          reason: 'over_cap',
        });
      }
      const parsed = parseEditorContent(body.content);
      if ('error' in parsed) return reply.status(400).send({ error: parsed.error });
      const frontmatter = stampPrincipalEdit(parsed.frontmatter);
      const size = okfByteSize({ type: parsed.type, frontmatter, body: parsed.body });
      if (size > editMaxBytes) {
        return reply.status(413).send({ error: `Document would be ${size} bytes — over the ${editMaxBytes}-byte console limit`, reason: 'over_cap' });
      }

      if (!(await auditRequested('update', { path, documentId: current.id, baseVersion: expectedVersion, byteSize: size }, reply))) return;
      const result = await workingDocs.update(path, {
        type: parsed.type,
        frontmatter,
        body: parsed.body,
        expectedVersion,
      });
      if (!result.ok) {
        // Never overwrite: hand back what is there now and let the principal decide.
        return reply.status(409).send({ conflict: true, ...(await detailJson(result.document)) });
      }
      const warnings = await recordCompleted('update', result.document);
      return reply.send({ ...(await detailJson(result.document)), warnings });
    } catch (err) {
      logger.error({ err, path }, 'PUT /api/documents/doc: save failed');
      return reply.status(500).send({ error: 'Failed to save document' });
    }
  });

  // -- POST /api/documents/archive — soft-delete (never a hard DELETE) --

  app.post('/api/documents/archive', WRITE_ROUTE, async (request, reply) => {
    const body = request.body as { path?: unknown; expectedVersion?: unknown } | undefined;
    const path = parseDocPath(body?.path);
    if (!path) return reply.status(400).send({ error: 'path must be an absolute .md document path' });
    const expectedVersion = body?.expectedVersion;
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
      return reply.status(400).send({ error: 'expectedVersion (the version you are looking at) is required' });
    }

    try {
      if (!(await auditRequested('archive', { path, documentId: null, baseVersion: expectedVersion, byteSize: null }, reply))) return;
      const result = await workingDocs.softDeleteAtVersion(path, expectedVersion);
      if (!result) return reply.status(404).send({ error: 'No live document at that path' });
      if (!result.ok) {
        // Never archive a version the principal hasn't seen — show them what is there now.
        return reply.status(409).send({ conflict: true, ...(await detailJson(result.document)) });
      }
      const warnings = await recordCompleted('archive', result.document);
      return reply.send({ ...(await detailJson(result.document)), warnings });
    } catch (err) {
      logger.error({ err, path }, 'POST /api/documents/archive: archive failed');
      return reply.status(500).send({ error: 'Failed to archive document' });
    }
  });

  // -- POST /api/documents/restore — return an archived row to live --

  app.post('/api/documents/restore', WRITE_ROUTE, async (request, reply) => {
    const body = request.body as { id?: unknown } | undefined;
    if (!isUuid(body?.id)) return reply.status(400).send({ error: 'id must be a UUID' });
    const id = body.id;

    try {
      const target = await workingDocs.readById(id);
      if (!target) return reply.status(404).send({ error: 'Document not found' });
      if (target.archivedAt === null) {
        return reply.status(400).send({ error: 'That document is not archived', reason: 'not_archived' });
      }
      if (!(await auditRequested('restore', { path: target.path, documentId: id, baseVersion: target.version, byteSize: null }, reply))) return;
      const result = await workingDocs.restore(id);
      if (!result.ok) {
        if (result.reason === 'not_found') return reply.status(404).send({ error: 'Document not found' });
        if (result.reason === 'not_archived') {
          return reply.status(400).send({ error: 'That document is not archived', reason: 'not_archived' });
        }
        return reply.status(409).send({
          error: 'Another live document now uses this path — archive or move it first',
          reason: 'path_in_use',
          livePath: result.document?.path ?? null,
        });
      }
      const warnings = await recordCompleted('restore', result.document);
      return reply.send({ ...(await detailJson(result.document)), warnings });
    } catch (err) {
      logger.error({ err, id }, 'POST /api/documents/restore: restore failed');
      return reply.status(500).send({ error: 'Failed to restore document' });
    }
  });
}
