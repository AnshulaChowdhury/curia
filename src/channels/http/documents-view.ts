// documents-view.ts — pure helpers behind the console Documents routes (#1821).
//
// Kept out of the route file so the shaping rules (progressive-render chunking, search
// context, scratch expiry, download naming) are unit-testable without Fastify or Postgres.

import { markdownToHtml } from '../../format/markdown-to-html.js';
import {
  isScratchDocumentPath,
  parseTtlDaysFrontmatter,
  resolveScratchDocTtlDays,
} from '../../agents/document-workspace.js';
import type { WorkingDocRow, WorkingDocSummary } from '../../db/working-docs-repo.js';

/** Target size of one progressive-render chunk. A 211 kB body becomes ~13 chunks. */
export const RENDER_CHUNK_TARGET_BYTES = 16 * 1024;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}#{1,6}\s/;

/**
 * Split a markdown body into chunks that each render to self-contained HTML, so the
 * console can paint the first screen of a very large document before the rest.
 *
 * Splits only on a blank line outside a fenced code block — never inside a fence, which
 * would leave an unterminated `<pre>`. Once a chunk reaches the target size it closes at
 * the next blank line that precedes a heading; past twice the target it closes at any
 * blank line, so a heading-free document still splits. Chunks concatenate back to the
 * original body exactly.
 */
export function splitMarkdownForProgressiveRender(
  body: string,
  targetBytes: number = RENDER_CHUNK_TARGET_BYTES,
): string[] {
  if (Buffer.byteLength(body, 'utf8') <= targetBytes) return [body];

  const lines = body.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    current.push(isLast ? line : `${line}\n`);
    currentBytes += Buffer.byteLength(line, 'utf8') + 1;

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }

    if (fence !== null || line.trim() !== '' || isLast) continue;
    const next = lines[i + 1] ?? '';
    const atHeading = HEADING_RE.test(next);
    if ((currentBytes >= targetBytes && atHeading) || currentBytes >= targetBytes * 2) {
      chunks.push(current.join(''));
      current = [];
      currentBytes = 0;
    }
  }
  if (current.length > 0) chunks.push(current.join(''));
  return chunks;
}

/** Render a body to sanitized HTML chunks for progressive display. */
export function renderBodyChunks(body: string): string[] {
  return splitMarkdownForProgressiveRender(body).map(chunk => markdownToHtml(chunk));
}

export interface ScratchExpiry {
  /** ISO timestamp the nightly purge will archive this document after; null when exempt. */
  expiresAt: string | null;
  /** True when `ttl_days: 0` pins the document. */
  exempt: boolean;
  /** Effective TTL in days (frontmatter override or the configured default). */
  ttlDays: number | null;
}

/**
 * Derived expiry for a `/scratch/<conversation>/…` document — `updated_at` plus the
 * effective TTL, mirroring `purgeExpiredScratch`. Returns null for non-scratch paths and
 * for archived rows (already swept or archived by hand).
 */
export function scratchExpiry(
  doc: Pick<WorkingDocSummary, 'path' | 'frontmatter' | 'updatedAt' | 'archivedAt'>,
  defaultTtlDays: number,
): ScratchExpiry | null {
  if (doc.archivedAt !== null || !isScratchDocumentPath(doc.path)) return null;
  const ttlDays = resolveScratchDocTtlDays(doc.path, doc.frontmatter, defaultTtlDays);
  if (ttlDays === null) {
    // resolveScratchDocTtlDays returns null for a scratch path only on ttl_days: 0.
    return { expiresAt: null, exempt: parseTtlDaysFrontmatter(doc.frontmatter) === 0, ttlDays: null };
  }
  const expires = new Date(new Date(doc.updatedAt).getTime() + ttlDays * 24 * 60 * 60 * 1000);
  return { expiresAt: expires.toISOString(), exempt: false, ttlDays };
}

/** Frontmatter title as a display hint, when it is a non-empty string. */
export function documentTitle(frontmatter: Record<string, unknown>): string | null {
  const title = frontmatter.title;
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
}

/** JSON shape of a document in list responses — no body. */
export function toSummaryJson(doc: WorkingDocSummary, defaultScratchTtlDays: number) {
  return {
    id: doc.id,
    path: doc.path,
    type: doc.type,
    title: documentTitle(doc.frontmatter),
    version: doc.version,
    byteSize: doc.byteSize,
    taskId: doc.taskId,
    conversationId: doc.conversationId,
    agentId: doc.agentId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    archivedAt: doc.archivedAt,
    scratchExpiry: scratchExpiry(doc, defaultScratchTtlDays),
  };
}

export type DocumentSearchMatch =
  | { id: string; path: string; archived: boolean; kind: 'path' }
  | { id: string; path: string; archived: boolean; kind: 'body'; lineNumber: number; context: string };

/** Longest line context returned per body match. */
export const SEARCH_CONTEXT_CHARS = 200;

/** Trim a matching line to a window around the first case-insensitive hit. */
export function matchContext(line: string, query: string, maxChars: number = SEARCH_CONTEXT_CHARS): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const at = trimmed.toLowerCase().indexOf(query.toLowerCase());
  const half = Math.floor((maxChars - query.length) / 2);
  const start = Math.max(0, Math.min(at - half, trimmed.length - maxChars));
  const end = Math.min(trimmed.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${trimmed.slice(start, end)}${end < trimmed.length ? '…' : ''}`;
}

/**
 * Every case-insensitive match in a document: one `path` match when the path contains
 * the query, then one `body` match per matching line. Unlike the `doc-search` skill this
 * is case-insensitive and uncapped — the route paginates the flattened list.
 */
export function documentMatches(doc: WorkingDocRow, query: string): DocumentSearchMatch[] {
  const needle = query.toLowerCase();
  const archived = doc.archivedAt !== null;
  const matches: DocumentSearchMatch[] = [];
  if (doc.path.toLowerCase().includes(needle)) {
    matches.push({ id: doc.id, path: doc.path, archived, kind: 'path' });
  }
  const lines = doc.body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.toLowerCase().includes(needle)) continue;
    matches.push({
      id: doc.id,
      path: doc.path,
      archived,
      kind: 'body',
      lineNumber: i + 1,
      context: matchContext(line, query),
    });
  }
  return matches;
}

/**
 * Download filename for one document: the leaf with its version and the first 8 hex digits
 * of its row id, e.g. `brief.v12.3f2a9c1d.md`. Both are what let a copy edited offline be
 * re-imported safely (#1823): the version is the optimistic-concurrency precondition, and
 * the id fragment catches a *different* row that now holds the path at the same version.
 */
export function downloadFilename(path: string, version: number, id: string): string {
  const leaf = path.split('/').pop() || 'document.md';
  const base = leaf.endsWith('.md') ? leaf.slice(0, -3) : leaf;
  return `${base}.v${version}.${id.replace(/-/g, '').slice(0, 8).toLowerCase()}.md`;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 `filename*`. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
