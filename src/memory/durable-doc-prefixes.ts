// durable-doc-prefixes.ts — OKF path prefixes that are never task-owned (#2322 / #2338).
//
// doc-write stamps the bound task's root id on ordinary paths, and
// archiveProjectWorkspaceDocs archives every live doc carrying that task_id.
// A prefix in this list is durable workspace state: no task stamp, and project
// archival leaves it alone. #2338 adds `/shared/` here; `/meetings/` is the
// agendas and minutes store.

import { normalizeDocPath } from './okf.js';

/** Path prefixes (leading slash, trailing slash) that outlive any one task. */
export const DURABLE_DOC_PREFIXES: readonly string[] = ['/meetings/'];

/** True when `path` is under a durable prefix. Normalizes before comparing. */
export function isDurableDocPath(path: string): boolean {
  const normalized = normalizeDocPath(path);
  return DURABLE_DOC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
