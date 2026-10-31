// okf-bundle-import.ts — plan and apply an OKF bundle import (#1823).
//
// Import is additive and never destructive: it creates documents that are missing and
// updates ones whose live version still matches the version the bundle was exported at.
// Anything else is a conflict and is left alone. Documents absent from the bundle are
// never touched.
//
// Planning is a pure read. Its token fingerprints every planned write, and apply refuses
// to run unless re-planning yields the same token — so confirming applies exactly what
// the preview showed, no more and no fewer.

import { createHash } from 'node:crypto';
import type { WorkingDocRow, WorkingDocsRepo } from '../db/working-docs-repo.js';
import { okfByteSize } from './okf.js';
import type { OkfBundleDocumentEntry, OkfBundleSkippedEntry } from './okf-bundle.js';

export type ImportAction = 'create' | 'update' | 'unchanged' | 'conflict';

/**
 * What the bundle copy of a document was based on. Versions restart at 1 for every row,
 * so a version alone can't tell the exported document from a newer one created at the
 * same path after the old one was archived — the row id (or its prefix) does.
 */
export interface ImportBase {
  version: number;
  id?: string;
  idPrefix?: string;
}

export interface ImportPlanItem {
  /** Bundle entry (or uploaded file) name. */
  name: string;
  path: string;
  action: ImportAction;
  /** Version the bundle was exported at, from the manifest or a `.vN.md` filename. */
  baseVersion: number | null;
  /** Live version now, when the path exists. */
  currentVersion: number | null;
  /** Why this is a conflict. */
  reason?: string;
  byteSize: number;
}

export interface ImportPlan {
  items: ImportPlanItem[];
  skipped: OkfBundleSkippedEntry[];
  counts: Record<ImportAction | 'skipped', number>;
  /** Fingerprint of the planned writes; apply must present the same one. */
  token: string;
}

/** JSON with object keys sorted at every level — frontmatter comparison ignores key order (jsonb does too). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** True when the store already holds exactly this content. */
export function sameDocumentContent(
  current: Pick<WorkingDocRow, 'type' | 'frontmatter' | 'body'>,
  incoming: Pick<OkfBundleDocumentEntry, 'type' | 'frontmatter' | 'body'>,
): boolean {
  return current.type === incoming.type
    && current.body === incoming.body
    && canonicalJson(current.frontmatter) === canonicalJson(incoming.frontmatter);
}

function contentHash(doc: Pick<OkfBundleDocumentEntry, 'type' | 'frontmatter' | 'body'>): string {
  return createHash('sha256').update(canonicalJson([doc.type, doc.frontmatter, doc.body])).digest('hex');
}

/**
 * Decide what importing `documents` would do. `baseVersions` maps a store path to the
 * version the bundle copy was based on; a path with no base version can still be
 * created, but never updated — there is nothing to prove the store hasn't moved on.
 */
export async function planImport(
  documents: OkfBundleDocumentEntry[],
  bases: ReadonlyMap<string, ImportBase>,
  skipped: OkfBundleSkippedEntry[],
  repo: Pick<WorkingDocsRepo, 'read'>,
): Promise<ImportPlan> {
  const items: ImportPlanItem[] = [];
  const hashes: string[] = [];
  for (const doc of documents) {
    const current = await repo.read(doc.path);
    const baseRef = bases.get(doc.path);
    const baseVersion = baseRef?.version ?? null;
    const sameRow = !baseRef
      || (baseRef.id !== undefined ? current?.id === baseRef.id
        : baseRef.idPrefix !== undefined ? current?.id.replace(/-/g, '').startsWith(baseRef.idPrefix) === true
          : true);
    const byteSize = okfByteSize({ type: doc.type, frontmatter: doc.frontmatter, body: doc.body });
    const base = { name: doc.name, path: doc.path, baseVersion, currentVersion: current?.version ?? null, byteSize };
    let item: ImportPlanItem;
    if (!current) {
      item = { ...base, action: 'create' };
    } else if (sameDocumentContent(current, doc)) {
      item = { ...base, action: 'unchanged' };
    } else if (baseVersion === null) {
      item = { ...base, action: 'conflict', reason: 'already exists and the bundle has no base version for it' };
    } else if (!sameRow) {
      item = { ...base, action: 'conflict', reason: 'a different document now lives at this path' };
    } else if (baseVersion !== current.version) {
      item = { ...base, action: 'conflict', reason: `changed since export (bundle v${baseVersion}, store v${current.version})` };
    } else {
      item = { ...base, action: 'update' };
    }
    items.push(item);
    hashes.push(item.action === 'create' || item.action === 'update' ? contentHash(doc) : '');
  }

  const counts: ImportPlan['counts'] = { create: 0, update: 0, unchanged: 0, conflict: 0, skipped: skipped.length };
  for (const item of items) counts[item.action]++;

  const token = createHash('sha256')
    .update(JSON.stringify(items.map((item, i) => [item.name, item.path, item.action, item.currentVersion, hashes[i]])))
    .update(JSON.stringify(skipped.map(s => s.name)))
    .digest('hex');
  return { items, skipped, counts, token };
}

export interface ImportApplyResult {
  created: string[];
  updated: string[];
  /** Planned writes that lost a race at write time — left as the store had them. */
  conflicts: Array<{ path: string; reason: string }>;
  /** Planned writes that errored. Writes are per document, so the others still landed. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Perform a plan's creates and updates. Each write is still guarded (unique live path for
 * creates, expectedVersion for updates), so a change that lands between plan and write
 * becomes a reported conflict instead of an overwrite.
 */
export async function applyImportPlan(
  plan: ImportPlan,
  documents: OkfBundleDocumentEntry[],
  repo: Pick<WorkingDocsRepo, 'create' | 'update' | 'read'>,
  transformFrontmatter: (frontmatter: Record<string, unknown>) => Record<string, unknown> = fm => fm,
): Promise<ImportApplyResult> {
  const byName = new Map(documents.map(d => [d.name, d]));
  const result: ImportApplyResult = { created: [], updated: [], conflicts: [], failed: [] };
  for (const item of plan.items) {
    if (item.action !== 'create' && item.action !== 'update') continue;
    const doc = byName.get(item.name)!;
    const frontmatter = transformFrontmatter(doc.frontmatter);
    // Each document is its own write. One failing must not hide the ones that landed —
    // the caller audits and reports exactly what happened.
    try {
      if (item.action === 'create') {
        try {
          await repo.create({ path: item.path, type: doc.type, frontmatter, body: doc.body });
          result.created.push(item.path);
        } catch (err) {
          if ((err as { code?: string }).code !== '23505') throw err;
          result.conflicts.push({ path: item.path, reason: 'created by someone else after the preview' });
        }
        continue;
      }
      let written;
      try {
        written = await repo.update(item.path, {
          type: doc.type,
          frontmatter,
          body: doc.body,
          expectedVersion: item.currentVersion!,
        });
      } catch (err) {
        // update() throws when no live row exists — archived since the preview.
        if (await repo.read(item.path)) throw err;
        result.conflicts.push({ path: item.path, reason: 'archived after the preview' });
        continue;
      }
      if (written.ok) result.updated.push(item.path);
      else result.conflicts.push({ path: item.path, reason: `changed after the preview (now v${written.document.version})` });
    } catch (err) {
      result.failed.push({ path: item.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
