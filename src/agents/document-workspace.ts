import type { WorkingDocRow, WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { Logger } from '../logger.js';
import {
  docDirectory,
  markdownFenceFor,
  normalizeDocPath,
  splitSections,
} from '../memory/okf.js';
import type { ResumableDocumentPointer } from '../db/resumable-progress.js';
import { isDocumentPointer } from '../db/resumable-progress.js';
import {
  projectDirectoryPrefix,
  resolveOwnedWorkspacePrefix,
} from './document-placement.js';

export const INDEX_FILENAME = 'index.md';
export const LOG_FILENAME = 'log.md';

/** Reserved leaf names — not overwritten by generic create/replace. */
export const RESERVED_LEAF_NAMES = new Set([INDEX_FILENAME, LOG_FILENAME]);

/** Default inactivity TTL for `/scratch/<conversation-id>/…` when config omits scratchTtlDays (#1212). */
export const DEFAULT_SCRATCH_DOC_TTL_DAYS = 7;

/** Max per-doc / config TTL — matches `documentWorkspace.scratchTtlDays` validation in config.ts. */
export const MAX_SCRATCH_DOC_TTL_DAYS = 36500;

/**
 * Ephemeral scratch workspace paths: `/scratch/<conversation-id>/…` with at least one
 * leaf segment (excludes bare `/scratch` and root-level `/scratch/foo.md`).
 */
export const SCRATCH_CONVERSATION_PATH_RE = /^\/scratch\/[^/]+\/.+/;

/** Normalize a directory prefix — always ends with `/`, never bare `/` unless root. */
export function normalizeDirectoryPrefix(prefix: string): string {
  const normalized = normalizeDocPath(prefix);
  if (normalized === '/') return '/';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

/** True when `path` is a direct child of `directoryPrefix`. */
export function isDirectChild(directoryPrefix: string, path: string): boolean {
  const dir = normalizeDirectoryPrefix(directoryPrefix);
  if (!path.startsWith(dir)) return false;
  const remainder = path.slice(dir.length);
  if (!remainder || remainder.includes('/')) return false;
  return true;
}

/** Build the index.md projection for a directory prefix from live document rows. */
export function buildIndexProjection(directoryPrefix: string, documents: WorkingDocRow[]): string {
  const dir = normalizeDirectoryPrefix(directoryPrefix);
  const children = documents
    .filter(d => isDirectChild(dir, d.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const lines: string[] = ['# Index', ''];
  if (children.length === 0) {
    lines.push('_No documents in this directory yet._');
    return `${lines.join('\n')}\n`;
  }

  for (const doc of children) {
    const leaf = doc.path.slice(dir.length);
    const title = typeof doc.frontmatter.title === 'string' && doc.frontmatter.title.trim()
      ? doc.frontmatter.title.trim()
      : leaf.replace(/\.md$/, '');
    lines.push(`- [${title}](${doc.path}) — \`${doc.type}\``);
  }
  return `${lines.join('\n')}\n`;
}

/** Format a log.md append entry per OKF / LLM-Wiki convention. */
export function formatLogEntry(isoTimestamp: string, operation: string, summary: string): string {
  const op = operation.trim() || 'write';
  const sum = summary.trim() || op;
  return `## [${isoTimestamp}] ${op} | ${sum}\n`;
}

export function logPathForDocument(documentPath: string): string {
  return `${docDirectory(documentPath)}${LOG_FILENAME}`;
}

/**
 * Frontmatter key the console stamps on a document the principal edits (#1822): an ISO
 * timestamp, so an agent that reads the document can tell the principal changed it.
 */
export const PRINCIPAL_EDIT_STAMP_KEY = 'principal_edited_at';

export interface DirectoryLogEntryParams {
  documentPath: string;
  operation: string;
  summary: string;
  conversationId?: string;
  agentId?: string;
  /** Prefix for warnings — the writer whose change this records (e.g. `doc-write`). */
  source: string;
}

/**
 * Append a change record to `log.md` in the document's directory, creating it on first
 * use. Shared by `doc-write` and the console Documents routes (#1822). Best-effort: the
 * document write already succeeded, so failures warn rather than throw. Returns whether
 * the entry was written, so a caller can surface a miss (the console does).
 *
 * The log stays unowned (no `task_id`): it is shared across tasks in the folder, and one
 * project's archival must not remove the audit trail (#1819 CodeRabbit).
 */
export async function appendDirectoryLogEntry(
  repo: Pick<WorkingDocsRepo, 'read' | 'create' | 'append'>,
  log: Logger,
  params: DirectoryLogEntryParams,
): Promise<boolean> {
  const logPath = logPathForDocument(params.documentPath);
  const entry = formatLogEntry(new Date().toISOString(), params.operation, params.summary);

  try {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const existing = await repo.read(logPath);
      if (!existing) {
        try {
          await repo.create({
            path: logPath,
            type: 'log',
            body: entry,
            conversationId: params.conversationId,
            agentId: params.agentId,
          });
          return true;
        } catch (err) {
          // Another writer may have created log.md between read and create — retry.
          if (attempt === maxAttempts - 1) throw err;
          continue;
        }
      }
      const result = await repo.append(logPath, {
        content: entry.trimEnd(),
        expectedVersion: existing.version,
      });
      if (result.ok) return true;
      if (attempt === maxAttempts - 1) {
        log.warn(
          { path: logPath, version: existing.version },
          `${params.source}: log.md append conflict after retries — change record may be missing for this write`,
        );
      }
    }
    return false;
  } catch (err) {
    log.warn(
      { err, path: logPath },
      `${params.source}: log.md append failed — document write succeeded; audit entry may be missing`,
    );
    return false;
  }
}

export function indexPathForDirectory(directoryPrefix: string): string {
  return `${normalizeDirectoryPrefix(directoryPrefix)}${INDEX_FILENAME}`;
}

/** Extract a `##` section body, or the full document when section is omitted. */
export function extractSectionContent(
  body: string,
  section?: string,
): { content: string; section?: string; found?: boolean } {
  if (!section || !section.trim()) {
    return { content: body };
  }
  const key = section.trim();
  const { sections } = splitSections(body);
  const match = sections.find(s => s.heading.toLowerCase() === key.toLowerCase());
  if (!match) {
    return { content: '', found: false };
  }
  const content = match.content.length > 0 ? `${match.content.replace(/\n$/, '')}\n` : '';
  return { content, section: match.heading, found: true };
}

/** True when the path names a document leaf (e.g. ends in `.md`), not a directory prefix. */
export function looksLikeDocumentPath(path: string): boolean {
  const normalized = normalizeDocPath(path);
  const leaf = normalized.split('/').pop() ?? '';
  return leaf.includes('.');
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

/** Case-sensitive substring grep across document bodies. */
export function grepDocuments(
  documents: WorkingDocRow[],
  query: string,
  options?: { maxMatches?: number },
): GrepMatch[] {
  const max = options?.maxMatches ?? 50;
  const matches: GrepMatch[] = [];
  for (const doc of documents) {
    const lines = doc.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes(query)) continue;
      matches.push({ path: doc.path, lineNumber: i + 1, line });
      if (matches.length >= max) return matches;
    }
  }
  return matches;
}

/** Parse scheduler / task-wake JSON content. Returns null for non-JSON payloads. */
export function parseTaskWakePayload(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Sync prefix resolution from wake payload alone (#1819).
 * Returns the document-pointer directory when present; otherwise null.
 * Does **not** invent `/projects/<task-uuid>/` — ownership / legacy lookup is async
 * via `resolveWorkspaceDirectoryPrefix`.
 */
function resolveWorkspacePrefixFromPayload(payload: Record<string, unknown>): string | null {
  const pointer = documentPointerFromProgress(payload.progress);
  if (pointer) {
    return docDirectory(pointer.path);
  }
  return null;
}

/** Parse scheduler / task-wake JSON content for a workspace directory prefix (pointer-only). */
export function resolveWorkspacePrefixFromTaskContent(content: string): string | null {
  const payload = parseTaskWakePayload(content);
  if (!payload) return null;
  return resolveWorkspacePrefixFromPayload(payload);
}

export interface ResolveWorkspaceDirectoryOptions {
  resolveRootTaskId?: (taskId: string) => Promise<string | null>;
  /** Pre-resolved project root — skips a second parent walk when the caller already has it. */
  rootTaskId?: string;
  /** Live documents owned by the root task (`task_id = root`). */
  listLiveByTaskId?: (rootTaskId: string) => Promise<WorkingDocRow[]>;
  /** Live documents under a path prefix (used for legacy UUID folders). */
  listByPrefix?: (prefix: string) => Promise<WorkingDocRow[]>;
}

/**
 * Resolve the workspace directory prefix for a wake payload (#1819).
 * Order: document pointer → owned `/projects/` docs → legacy UUID prefix → null.
 * Never invents `/projects/<uuid>/` when the agent has not placed documents yet.
 */
export async function resolveWorkspaceDirectoryPrefix(
  content: string,
  resolveRootTaskIdOrOptions?:
    | ((taskId: string) => Promise<string | null>)
    | ResolveWorkspaceDirectoryOptions,
): Promise<string | null> {
  const options: ResolveWorkspaceDirectoryOptions =
    typeof resolveRootTaskIdOrOptions === 'function'
      ? { resolveRootTaskId: resolveRootTaskIdOrOptions }
      : (resolveRootTaskIdOrOptions ?? {});

  const payload = parseTaskWakePayload(content);
  if (!payload) return null;

  const pointer = documentPointerFromProgress(payload.progress);
  if (pointer) {
    return docDirectory(pointer.path);
  }

  const taskId = typeof payload.task_id === 'string' && payload.task_id.length > 0
    ? payload.task_id
    : null;
  if (!taskId) return null;

  let rootTaskId = options.rootTaskId ?? taskId;
  if (!options.rootTaskId && options.resolveRootTaskId) {
    const root = await options.resolveRootTaskId(taskId);
    if (root) rootTaskId = root;
  }

  const ownedDocuments = options.listLiveByTaskId
    ? await options.listLiveByTaskId(rootTaskId)
    : [];
  const legacyPrefix = projectDirectoryPrefix(rootTaskId);
  const legacyUuidDocuments = options.listByPrefix
    ? await options.listByPrefix(legacyPrefix)
    : undefined;

  return resolveOwnedWorkspacePrefix({
    rootTaskId,
    pointer: null,
    ownedDocuments,
    legacyUuidDocuments,
  });
}

/** Read a document pointer from scheduler / task-wake JSON content. */
export function documentPointerFromTaskContent(content: string): ResumableDocumentPointer | null {
  const payload = parseTaskWakePayload(content);
  if (!payload) return null;
  return documentPointerFromProgress(payload.progress);
}

/** Build the tail message block injected on task resume (manifest only). */
export function formatWorkspaceManifestBlock(directoryPrefix: string, indexBody: string): string {
  const dir = normalizeDirectoryPrefix(directoryPrefix);
  return [
    '## Workspace Manifest',
    '',
    `Directory \`${dir}\` — index projection only. Use \`doc-read\` for document bodies.`,
    '',
    '```markdown',
    indexBody.trimEnd(),
    '```',
  ].join('\n');
}

/** Build the tail message block for a spilled resumable accumulator document (#1210). */
export function formatAccumulatorResumeBlock(
  pointer: ResumableDocumentPointer,
  content: string,
  resolvedSection?: string,
): string {
  const sectionName = pointer.section ?? resolvedSection;
  const sectionClause = sectionName ? ` (section \`${sectionName}\`)` : '';
  const trimmed = content.trimEnd();
  const fence = markdownFenceFor(trimmed);
  return [
    '## Resumable Accumulator',
    '',
    `Document \`${pointer.path}\`${sectionClause} — checkpoint spill from your last run:`,
    '',
    `${fence}markdown`,
    trimmed,
    fence,
  ].join('\n');
}

export function documentPointerFromProgress(progress: unknown): ResumableDocumentPointer | null {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
  const resumable = (progress as Record<string, unknown>).resumable;
  if (!resumable || typeof resumable !== 'object' || Array.isArray(resumable)) return null;
  const accumulator = (resumable as Record<string, unknown>).accumulator;
  return isDocumentPointer(accumulator) ? accumulator : null;
}

/** True for `/scratch/<conversation-id>/…` paths subject to TTL sweep (#1212). */
export function isScratchDocumentPath(path: string): boolean {
  return SCRATCH_CONVERSATION_PATH_RE.test(normalizeDocPath(path));
}

/** Parse optional `ttl_days` from OKF frontmatter. Non-numeric / out-of-range values are unset. */
export function parseTtlDaysFrontmatter(frontmatter: Record<string, unknown>): number | undefined {
  const raw = frontmatter.ttl_days;
  if (raw === undefined || raw === null) return undefined;
  let parsed: number | undefined;
  if (typeof raw === 'number' && Number.isInteger(raw)) parsed = raw;
  else if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    parsed = Number.parseInt(raw.trim(), 10);
  } else {
    return undefined;
  }
  if (parsed < 0 || parsed > MAX_SCRATCH_DOC_TTL_DAYS) return undefined;
  return parsed;
}

/**
 * Resolve effective scratch TTL in days for purge eligibility.
 * Returns `null` when the document opts out (`ttl_days: 0`) or is not under `/scratch/`.
 */
export function resolveScratchDocTtlDays(
  path: string,
  frontmatter: Record<string, unknown>,
  defaultScratchTtlDays: number,
): number | null {
  if (!isScratchDocumentPath(path)) return null;
  const ttlDays = parseTtlDaysFrontmatter(frontmatter);
  if (ttlDays === 0) return null;
  if (ttlDays !== undefined && ttlDays > 0) return ttlDays;
  return defaultScratchTtlDays;
}

/** Warn when frontmatter sets ttl_days on a non-scratch path (value is ignored at purge time). */
export function ttlDaysFrontmatterWarning(
  path: string,
  frontmatter?: Record<string, unknown>,
): string | null {
  if (!frontmatter || parseTtlDaysFrontmatter(frontmatter) === undefined) return null;
  if (isScratchDocumentPath(path)) return null;
  return 'ttl_days in frontmatter only affects retention for /scratch/ paths — this document will not auto-expire';
}
