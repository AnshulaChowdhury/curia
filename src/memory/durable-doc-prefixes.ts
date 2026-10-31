// durable-doc-prefixes.ts — OKF path prefixes that are never task-owned (#2322 / #2338).
//
// doc-write stamps the bound task's root id on ordinary paths, and
// archiveProjectWorkspaceDocs archives every live doc carrying that task_id.
// A prefix in this list is durable workspace state: no task stamp, and project
// archival leaves it alone. `/shared/` holds documents agents declare in
// `pinned_context` (#2338); `/meetings/` is the agendas and minutes store (#2322).

import { normalizeDocPath } from './okf.js';

/** Documents agents declare in `pinned_context`. Writable only by a declaring agent. */
export const SHARED_DOC_PREFIX = '/shared/';

/** Path prefixes (leading slash, trailing slash) that outlive any one task. */
export const DURABLE_DOC_PREFIXES: readonly string[] = [SHARED_DOC_PREFIX, '/meetings/'];

/** True when `path` is under a durable prefix. Normalizes before comparing. */
export function isDurableDocPath(path: string): boolean {
  const normalized = normalizeDocPath(path);
  return DURABLE_DOC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** True when `path` is under `/shared/`. Normalizes before comparing. */
export function isSharedDocPath(path: string): boolean {
  return normalizeDocPath(path).startsWith(SHARED_DOC_PREFIX);
}
