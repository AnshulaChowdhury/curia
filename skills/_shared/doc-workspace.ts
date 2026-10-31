// Shared helpers for doc-* skills (#1209).

import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import type { WorkingDocRow, WorkingDocWriteResult } from '../../src/db/working-docs-repo.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import {
  appendDirectoryLogEntry,
  buildIndexProjection,
  extractSectionContent,
  grepDocuments,
  indexPathForDirectory,
  normalizeDirectoryPrefix,
  RESERVED_LEAF_NAMES,
  LOG_FILENAME,
  ttlDaysFrontmatterWarning,
} from '../../src/agents/document-workspace.js';
import { normalizeDocPath } from '../../src/memory/okf.js';

export function requireWorkingDocs(ctx: ToolContext): ToolResult | null {
  if (!ctx.workingDocs) {
    ctx.log.error('doc-*: workingDocs not available');
    return { success: false, error: 'Document workspace not available — database not configured' };
  }
  return null;
}

export function mapDocumentRow(doc: WorkingDocRow, timezone: string) {
  const updatedUnix = Math.floor(new Date(doc.updatedAt).getTime() / 1000);
  const createdUnix = Math.floor(new Date(doc.createdAt).getTime() / 1000);
  return {
    path: doc.path,
    type: doc.type,
    frontmatter: doc.frontmatter,
    body: doc.body,
    version: doc.version,
    section_versions: doc.sectionVersions,
    byte_size: doc.byteSize,
    task_id: doc.taskId,
    conversation_id: doc.conversationId,
    agent_id: doc.agentId,
    created_at: toLocalIso(createdUnix, timezone),
    updated_at: toLocalIso(updatedUnix, timezone),
    displayTimezone: formatDisplayTimezone(timezone, new Date()),
  };
}

export function mapWriteConflict(result: WorkingDocWriteResult, timezone: string) {
  if (result.ok) return null;
  const updatedUnix = Math.floor(new Date(result.document.updatedAt).getTime() / 1000);
  return {
    conflict: true,
    path: result.document.path,
    version: result.document.version,
    section_versions: result.document.sectionVersions,
    updated_at: toLocalIso(updatedUnix, timezone),
    displayTimezone: formatDisplayTimezone(timezone, new Date()),
  };
}

export async function appendDirectoryLog(
  ctx: ToolContext,
  documentPath: string,
  operation: string,
  summary: string,
  _taskId?: string,
): Promise<void> {
  // Intentionally ignore `_taskId`: directory log.md is shared across tasks in the
  // folder and must stay unowned so one project's archival cannot remove the audit trail
  // (#1819 CodeRabbit).
  void _taskId;
  await appendDirectoryLogEntry(ctx.workingDocs!, ctx.log, {
    documentPath,
    operation,
    summary,
    conversationId: ctx.conversationId ?? undefined,
    agentId: ctx.agentId ?? undefined,
    source: 'doc-write',
  });
}

export async function listDirectoryProjection(
  ctx: ToolContext,
  prefix: string,
): Promise<{ directory: string; index_path: string; manifest: string; documents: WorkingDocRow[] }> {
  const repo = ctx.workingDocs!;
  const directory = normalizeDirectoryPrefix(prefix);
  const documents = await repo.listByPrefix(directory);
  const manifest = buildIndexProjection(directory, documents);
  return {
    directory,
    index_path: indexPathForDirectory(directory),
    manifest,
    documents,
  };
}

export async function readDocument(
  ctx: ToolContext,
  path: string,
  section?: string,
): Promise<ToolResult> {
  const guard = requireWorkingDocs(ctx);
  if (guard) return guard;

  const normalized = normalizeDocPath(path);
  const doc = await ctx.workingDocs!.read(normalized);
  if (!doc) {
    return { success: true, data: { found: false, path: normalized } };
  }

  const timezone = ctx.timezone ?? 'UTC';
  const sectionResult = extractSectionContent(doc.body, section);
  const displayTimezone = timezone === 'UTC' ? 'UTC' : formatDisplayTimezone(timezone, new Date());
  const updatedUnix = Math.floor(new Date(doc.updatedAt).getTime() / 1000);
  const data: Record<string, unknown> = {
    found: true,
    path: doc.path,
    type: doc.type,
    frontmatter: doc.frontmatter,
    version: doc.version,
    section_versions: doc.sectionVersions,
    updated_at: toLocalIso(updatedUnix, timezone),
    displayTimezone,
  };
  if (section && section.trim()) {
    data.section = sectionResult.section ?? section.trim();
    data.content = sectionResult.content;
    data.section_found = sectionResult.found === true;
  } else {
    data.body = doc.body;
    data.okf = ctx.workingDocs!.toOkf(doc);
  }
  return { success: true, data };
}

export async function searchDocuments(
  ctx: ToolContext,
  query: string,
  pathPrefix?: string,
): Promise<ToolResult> {
  const guard = requireWorkingDocs(ctx);
  if (guard) return guard;

  const prefix = pathPrefix ? normalizeDirectoryPrefix(pathPrefix) : '/';
  const documents = await ctx.workingDocs!.listByPrefix(prefix);
  const matches = grepDocuments(documents, query);
  const timezone = ctx.timezone ?? 'UTC';
  const displayTimezone = timezone === 'UTC' ? 'UTC' : formatDisplayTimezone(timezone, new Date());
  return {
    success: true,
    data: {
      query,
      path_prefix: prefix,
      match_count: matches.length,
      matches: matches.map(m => ({
        path: m.path,
        line_number: m.lineNumber,
        line: m.line,
      })),
      displayTimezone,
    },
  };
}

export function validateWritePath(path: string, _mode: string): string | null {
  const normalized = normalizeDocPath(path);
  const leaf = normalized.split('/').pop() ?? '';
  if (!RESERVED_LEAF_NAMES.has(leaf)) return null;
  if (leaf === LOG_FILENAME) {
    return `Cannot write to reserved file ${leaf} — log entries are appended automatically by doc-write`;
  }
  return `Cannot write to reserved file ${leaf} — use doc-list for the index projection`;
}

export { ttlDaysFrontmatterWarning };
