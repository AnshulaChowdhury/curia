// pinned-context.ts — agent YAML `pinned_context` (#2338).
//
// An agent declares the `/shared/` documents and config-store keys that are part
// of how it works. The runtime renders a `## Pinned context` block with their
// current contents into the system string on every turn (buildBaseSystemPrompt),
// and doc-write lets only a declaring agent write a `/shared/` path. See ADR-056.
//
// Three pieces live here:
//   - parsePinnedContext(): validate the YAML field at agent load. A bad entry
//     fails the load with an error naming the agent and the entry.
//   - createPinnedContextReader(): the per-turn reads, from the document
//     workspace and config-store.
//   - renderPinnedContextBlock(): the block itself. Never throws; a failed read
//     renders as unavailable instead of being dropped.

import type { Logger } from '../logger.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import { ConfigStore } from '../memory/config-store.js';
import { SHARED_DOC_PREFIX } from '../memory/durable-doc-prefixes.js';
import { normalizeDocPath } from '../memory/okf.js';
import { RESERVED_LEAF_NAMES } from './document-workspace.js';

export type PinnedContextEntry =
  | { kind: 'doc'; path: string }
  | { kind: 'config'; namespace: string; key: string };

/** Same caps config-store applies on write, so a declared key is one it can hold. */
const MAX_CONFIG_NAMESPACE_LENGTH = 100;
const MAX_CONFIG_KEY_LENGTH = 200;

/** Default `documentWorkspace.pinnedContextWarnChars`: warn, never truncate, above this. */
export const DEFAULT_PINNED_CONTEXT_WARN_CHARS = 16_000;

/**
 * Validate and normalize an agent's `pinned_context`. Returns [] when the field is
 * absent. Throws on a malformed entry, a `doc:` path outside `/shared/`, a
 * `config:` entry without exactly one `/`, or a duplicate.
 */
export function parsePinnedContext(raw: unknown, agentName: string): PinnedContextEntry[] {
  if (raw === undefined || raw === null) return [];
  const fail = (detail: string, entry?: unknown): never => {
    const shown = entry === undefined ? '' : ` (entry: ${JSON.stringify(entry)})`;
    throw new Error(`Invalid pinned_context in agent '${agentName}': ${detail}${shown}`);
  };
  if (!Array.isArray(raw)) fail('must be a list of `doc:` or `config:` entries');

  const entries: PinnedContextEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail('each entry must be a mapping with exactly one of `doc` or `config`', item);
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.length !== 1 || (keys[0] !== 'doc' && keys[0] !== 'config')) {
      fail('each entry must have exactly one of `doc` or `config`', item);
    }
    const kind = keys[0] as 'doc' | 'config';
    const value = (item as Record<string, unknown>)[kind];
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`\`${kind}\` must be a non-empty string`, item);
    }
    const text = (value as string).trim();

    let entry: PinnedContextEntry;
    if (kind === 'doc') {
      // Normalize first so `..` cannot climb out of /shared/ and the declared path
      // matches what doc-write compares against.
      const path = normalizeDocPath(text);
      if (!path.startsWith(SHARED_DOC_PREFIX) || path.length === SHARED_DOC_PREFIX.length) {
        fail(`\`doc\` path must be a document under ${SHARED_DOC_PREFIX}`, item);
      }
      const leaf = path.split('/').pop() ?? '';
      if (RESERVED_LEAF_NAMES.has(leaf)) {
        fail(`\`doc\` path cannot be the reserved file ${leaf}`, item);
      }
      entry = { kind: 'doc', path };
    } else {
      // Whole namespaces are deliberately unsupported: they mix principal settings
      // with agent runtime state (#940).
      const parts = text.split('/');
      if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
        fail('`config` must be `<namespace>/<key>` with exactly one `/`', item);
      }
      const namespace = parts[0]!.trim();
      const key = parts[1]!.trim();
      if (namespace.length > MAX_CONFIG_NAMESPACE_LENGTH || key.length > MAX_CONFIG_KEY_LENGTH) {
        fail(
          `\`config\` namespace must be ${MAX_CONFIG_NAMESPACE_LENGTH} characters or fewer and key ${MAX_CONFIG_KEY_LENGTH} or fewer`,
          item,
        );
      }
      entry = { kind: 'config', namespace, key };
    }

    const id = pinnedEntryLabel(entry);
    if (seen.has(id)) fail(`duplicate entry ${id}`, item);
    seen.add(id);
    entries.push(entry);
  }
  return entries;
}

/** The `/shared/` paths an agent declares — what doc-write checks a write against. */
export function pinnedDocPaths(entries: readonly PinnedContextEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'doc' ? [e.path] : []));
}

function pinnedEntryLabel(entry: PinnedContextEntry): string {
  return entry.kind === 'doc' ? `doc:${entry.path}` : `config:${entry.namespace}/${entry.key}`;
}

/**
 * Per-turn reads for the block. Both return null for "does not exist yet" and
 * throw when the read itself failed, so the two render differently.
 */
export interface PinnedContextReader {
  /** The document serialized as OKF markdown (frontmatter + body), with its version. */
  readDoc(path: string): Promise<{ version: number; content: string } | null>;
  readConfig(namespace: string, key: string): Promise<string | null>;
  /** An injected item longer than this logs a warning. It is still injected in full. */
  warnChars: number;
}

/**
 * Build the reader from the services bootstrap already has. Absent services make
 * the matching reads throw, so the entry renders as unavailable rather than as
 * "not yet created" — an agent must not create over a document it cannot see.
 */
export function createPinnedContextReader(deps: {
  workingDocsRepo?: WorkingDocsRepo;
  entityMemory?: EntityMemory;
  logger: Logger;
  warnChars?: number;
}): PinnedContextReader {
  const configStore = deps.entityMemory ? new ConfigStore(deps.entityMemory, deps.logger) : undefined;
  return {
    warnChars: deps.warnChars ?? DEFAULT_PINNED_CONTEXT_WARN_CHARS,
    async readDoc(path) {
      if (!deps.workingDocsRepo) throw new Error('document workspace not configured');
      const doc = await deps.workingDocsRepo.read(path);
      return doc ? { version: doc.version, content: deps.workingDocsRepo.toOkf(doc) } : null;
    },
    async readConfig(namespace, key) {
      if (!configStore) throw new Error('knowledge graph not configured');
      return configStore.get(namespace, key);
    },
  };
}

/**
 * A code fence longer than any backtick run in `text`, so a document containing
 * its own fences (or `##` headings) cannot break out of the block.
 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

const NOT_YET_CREATED_DOC =
  '_Not yet created._ Create it with `doc-write` mode `create` when you first need to write it.';
const NOT_YET_SET_CONFIG = '_Not set yet._';
const UNAVAILABLE =
  '_Unavailable this turn: the read failed._ Do not treat it as empty, and do not create or overwrite it this turn.';

/**
 * Render `## Pinned context` for the declared entries, read fresh now. Returns
 * null when nothing is declared. Never throws: a failed read renders as
 * unavailable and logs a warning.
 */
export async function renderPinnedContextBlock(
  entries: readonly PinnedContextEntry[],
  reader: PinnedContextReader,
  opts: { agentId: string; logger: Logger },
): Promise<string | null> {
  if (entries.length === 0) return null;
  const { agentId, logger } = opts;

  const warnIfLarge = (entry: string, length: number): void => {
    if (length > reader.warnChars) {
      logger.warn(
        { agentId, entry, chars: length, warnChars: reader.warnChars },
        'pinned_context: injected item exceeds the size warning threshold — injected in full',
      );
    }
  };

  const sections = await Promise.all(entries.map(async (entry): Promise<string> => {
    const label = pinnedEntryLabel(entry);
    if (entry.kind === 'doc') {
      try {
        const doc = await reader.readDoc(entry.path);
        if (!doc) return `### Document ${entry.path}\n${NOT_YET_CREATED_DOC}`;
        warnIfLarge(label, doc.content.length);
        return `### Document ${entry.path} (version ${doc.version})\n${fenced(doc.content)}`;
      } catch (err) {
        logger.warn({ err, agentId, entry: label }, 'pinned_context: document read failed — rendered as unavailable');
        return `### Document ${entry.path}\n${UNAVAILABLE}`;
      }
    }
    const name = `${entry.namespace}/${entry.key}`;
    try {
      const value = await reader.readConfig(entry.namespace, entry.key);
      if (value === null) return `### Config ${name}\n${NOT_YET_SET_CONFIG}`;
      warnIfLarge(label, value.length);
      return `### Config ${name}\n${fenced(value)}`;
    } catch (err) {
      logger.warn({ err, agentId, entry: label }, 'pinned_context: config read failed — rendered as unavailable');
      return `### Config ${name}\n${UNAVAILABLE}`;
    }
  }));

  return [
    '## Pinned context',
    'Current contents of the documents and settings you work from, read fresh this turn. Do not call a tool to load them. Write documents with `doc-write`, passing the version shown; change settings with `config-store`.',
    ...sections,
  ].join('\n\n');
}
