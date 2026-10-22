// documents-utils.ts — pure helpers for the Memory → Documents page (#1821).

export interface ScratchExpiry {
  expiresAt: string | null;
  exempt: boolean;
  ttlDays: number | null;
}

/** A document as listed by GET /api/documents — no body. */
export interface DocSummary {
  id: string;
  path: string;
  type: string;
  title: string | null;
  version: number;
  byteSize: number;
  taskId: string | null;
  conversationId: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  scratchExpiry: ScratchExpiry | null;
}

/** A directory in the path-prefix tree. `prefix` always ends with `/`. */
export interface DocTreeDir {
  name: string;
  prefix: string;
  dirs: DocTreeDir[];
  docs: DocSummary[];
  /** Documents at or below this directory. */
  total: number;
}

/**
 * Build the directory tree from a flat document list. Directories are just path
 * prefixes (OKF spec 20 §3), so this is `ls` applied recursively — no other grouping.
 * Archived rows can share a path with each other or a live row; each stays its own leaf.
 */
export function buildDocTree(docs: DocSummary[], rootPrefix = '/'): DocTreeDir {
  const root: DocTreeDir = { name: rootPrefix, prefix: rootPrefix, dirs: [], docs: [], total: 0 };
  for (const doc of docs) {
    if (!doc.path.startsWith(rootPrefix)) continue;
    const segments = doc.path.slice(rootPrefix.length).split('/').filter(Boolean);
    let dir = root;
    dir.total++;
    for (const segment of segments.slice(0, -1)) {
      let child = dir.dirs.find(d => d.name === segment);
      if (!child) {
        child = { name: segment, prefix: `${dir.prefix}${segment}/`, dirs: [], docs: [], total: 0 };
        dir.dirs.push(child);
      }
      child.total++;
      dir = child;
    }
    dir.docs.push(doc);
  }
  sortTree(root);
  return root;
}

function sortTree(dir: DocTreeDir): void {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
  dir.docs.sort((a, b) => a.path.localeCompare(b.path) || b.updatedAt.localeCompare(a.updatedAt));
  dir.dirs.forEach(sortTree);
}

/** Newest first — the "recent" view's order. */
export function sortByUpdatedDesc(docs: DocSummary[]): DocSummary[] {
  return [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
}

/** The parent directory prefixes of a path, outermost first: `/a/b/c.md` → `['/a/', '/a/b/']`. */
export function ancestorPrefixes(path: string): string[] {
  const segments = path.split('/').filter(Boolean).slice(0, -1);
  const out: string[] = [];
  let prefix = '/';
  for (const segment of segments) {
    prefix = `${prefix}${segment}/`;
    out.push(prefix);
  }
  return out;
}

export function leafName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Human summary of a scratch document's sweep date. */
export function describeExpiry(expiry: ScratchExpiry, now: Date = new Date()): string {
  if (expiry.exempt) return 'Pinned — exempt from the scratch sweep (ttl_days: 0)';
  if (!expiry.expiresAt) return 'No expiry';
  const at = new Date(expiry.expiresAt);
  const days = Math.ceil((at.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const when = at.toLocaleDateString();
  if (days <= 0) return `Due for the next scratch sweep (expired ${when})`;
  return `Swept after ${when} (${days} day${days === 1 ? '' : 's'}, TTL ${expiry.ttlDays ?? '?'}d)`;
}

/**
 * Resolve a link in a rendered document body to a store path, the way the store's link
 * index does: absolute paths as-is, relative ones against the document's directory.
 * Returns null for external URLs, fragments and other schemes — those open normally.
 */
export function resolveDocHref(sourcePath: string, href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    return null;
  }
  const base = trimmed.startsWith('/') ? '' : sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
  const resolved: string[] = [];
  for (const segment of `${base}${trimmed.split('#')[0]}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') resolved.pop();
    else resolved.push(decodeURIComponent(segment));
  }
  return `/${resolved.join('/')}`;
}

/** Display a frontmatter value: strings bare, everything else as compact JSON. */
export function formatFrontmatterValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
