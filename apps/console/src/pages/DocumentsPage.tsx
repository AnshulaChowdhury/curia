// DocumentsPage — Memory → Documents: browse, view and search the OKF working-document
// store (#1821). Navigation is path-based: directories are path prefixes and the
// frontmatter title is only a hint beside the path.

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';
import {
  ancestorPrefixes,
  buildDocTree,
  describeExpiry,
  formatBytes,
  formatFrontmatterValue,
  formatTimestamp,
  leafName,
  resolveDocHref,
  sortByUpdatedDesc,
  type DocSummary,
  type DocTreeDir,
} from './documents-utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type Status = 'live' | 'archived' | 'all';
type ListView = 'tree' | 'recent';

interface DocDetail extends DocSummary {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface DocResponse {
  document: DocDetail;
  htmlChunks: string[];
  backlinks: Array<{ sourcePath: string; linkKind: 'markdown' | 'wikilink' }>;
}

type SearchMatch =
  | { id: string; path: string; archived: boolean; kind: 'path' }
  | { id: string; path: string; archived: boolean; kind: 'body'; lineNumber: number; context: string };

interface SearchResponse {
  total: number;
  documentCount: number;
  offset: number;
  matches: SearchMatch[];
}

/** What the URL points at: the live document at a path, or a specific row by id. */
type Selection = { path: string } | { id: string } | null;

const SEARCH_PAGE_SIZE = 50;

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json() as { error?: string };
    return data.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function docQuery(selection: NonNullable<Selection>): string {
  return 'id' in selection
    ? `id=${encodeURIComponent(selection.id)}`
    : `path=${encodeURIComponent(selection.path)}`;
}

// ── Tree ──────────────────────────────────────────────────────────────────────

function DocRow({ doc, active, onOpen }: { doc: DocSummary; active: boolean; onOpen: (doc: DocSummary) => void }) {
  return (
    <button
      type="button"
      className={`docs-row${active ? ' active' : ''}${doc.archivedAt ? ' archived' : ''}`}
      onClick={() => onOpen(doc)}
      title={doc.path}
    >
      <span className="docs-row-name">{leafName(doc.path)}</span>
      {doc.title && <span className="docs-row-hint">{doc.title}</span>}
      {doc.archivedAt && <span className="docs-badge archived">archived</span>}
    </button>
  );
}

function TreeDir({
  dir, depth, expanded, onToggle, onFilter, selectedId, onOpen,
}: {
  dir: DocTreeDir;
  depth: number;
  expanded: Set<string>;
  onToggle: (prefix: string) => void;
  onFilter: (prefix: string) => void;
  selectedId: string | null;
  onOpen: (doc: DocSummary) => void;
}) {
  return (
    <div className="docs-tree-children" style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      {dir.dirs.map(child => {
        const open = expanded.has(child.prefix);
        return (
          <div key={child.prefix}>
            <div className="docs-dir">
              <button type="button" className="docs-dir-toggle" onClick={() => onToggle(child.prefix)} aria-expanded={open}>
                <span className="docs-dir-caret">{open ? '▾' : '▸'}</span>
                <span className="docs-dir-name">{child.name}/</span>
                <span className="docs-dir-count">{child.total}</span>
              </button>
              <button
                type="button"
                className="docs-dir-filter"
                onClick={() => onFilter(child.prefix)}
                title={`Show only ${child.prefix}`}
                aria-label={`Show only ${child.prefix}`}
              >
                only
              </button>
            </div>
            {open && (
              <TreeDir
                dir={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onFilter={onFilter}
                selectedId={selectedId}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
      {dir.docs.map(doc => (
        <DocRow key={doc.id} doc={doc} active={doc.id === selectedId} onOpen={onOpen} />
      ))}
    </div>
  );
}

// ── Search results ────────────────────────────────────────────────────────────

function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || query === '') return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

// ── Document view ─────────────────────────────────────────────────────────────

/**
 * Paints the first HTML chunk immediately and appends the rest one per tick, so a
 * 200 kB+ document shows its top at once instead of blocking on one huge innerHTML.
 * Remount (via `key`) to restart for a different document or version.
 */
function ProgressiveBody({ chunks, onLinkClick }: { chunks: string[]; onLinkClick: (e: MouseEvent<HTMLDivElement>) => void }) {
  const [shown, setShown] = useState(1);
  useEffect(() => {
    if (shown >= chunks.length) return;
    const handle = window.setTimeout(() => setShown(n => n + 1), 0);
    return () => window.clearTimeout(handle);
  }, [shown, chunks.length]);

  return (
    <div className="docs-body markdown-body" onClick={onLinkClick}>
      {chunks.slice(0, shown).map((html, i) => (
        // HTML is rendered and sanitized server-side (markdownToHtml + sanitize-html).
        <div key={i} dangerouslySetInnerHTML={{ __html: html }} />
      ))}
      {shown < chunks.length && (
        <div className="docs-body-progress">Rendering… {shown} of {chunks.length} parts</div>
      )}
    </div>
  );
}

function MetaField({ label, value, mono }: { label: string; value: string | null | number; mono?: boolean }) {
  return (
    <div className="kg-detail-field">
      <div className="kg-detail-field-label">{label}</div>
      <div className={`kg-detail-field-value${mono ? ' mono' : ''}`}>{value === null || value === '' ? '—' : String(value)}</div>
    </div>
  );
}

function DocumentView({
  data, onOpenPath,
}: {
  data: DocResponse;
  onOpenPath: (path: string) => void;
}) {
  const doc = data.document;
  const frontmatterEntries = Object.entries(doc.frontmatter);
  const downloadHref = `/api/documents/download?${docQuery({ id: doc.id })}`;

  // Links between documents resolve inside the console instead of navigating the SPA
  // to a relative URL that means nothing to it.
  function handleBodyClick(e: MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const target = resolveDocHref(doc.path, anchor.getAttribute('href') ?? '');
    if (target === null) return;
    e.preventDefault();
    onOpenPath(target);
  }

  return (
    <div className="docs-view">
      <div className="docs-view-header">
        <h2 className="docs-view-path">{doc.path}</h2>
        {doc.title && <div className="docs-view-title">{doc.title}</div>}
        <div className="kg-detail-badges">
          <span className="docs-badge">{doc.type}</span>
          {doc.archivedAt && <span className="docs-badge archived">archived · read-only</span>}
          {doc.scratchExpiry && (
            <span className={`docs-badge${doc.scratchExpiry.exempt ? ' pinned' : ' expiring'}`}>
              {describeExpiry(doc.scratchExpiry)}
            </span>
          )}
        </div>
        <div className="docs-view-actions">
          <a className="btn btn-secondary btn-sm" href={downloadHref} download>
            Download
          </a>
        </div>
      </div>

      <div className="docs-view-columns">
        <ProgressiveBody key={`${doc.id}:${doc.version}`} chunks={data.htmlChunks} onLinkClick={handleBodyClick} />

        <aside className="docs-meta">
          <section>
            <h3 className="docs-meta-heading">Metadata</h3>
            <MetaField label="Version" value={doc.version} />
            <MetaField label="Size" value={formatBytes(doc.byteSize)} />
            <MetaField label="Updated" value={formatTimestamp(doc.updatedAt)} />
            <MetaField label="Created" value={formatTimestamp(doc.createdAt)} />
            {doc.archivedAt && <MetaField label="Archived" value={formatTimestamp(doc.archivedAt)} />}
            <MetaField label="Task" value={doc.taskId} mono />
            <MetaField label="Conversation" value={doc.conversationId} mono />
            <MetaField label="Agent" value={doc.agentId} mono />
          </section>

          <section>
            <h3 className="docs-meta-heading">Frontmatter</h3>
            <table className="kg-props-table">
              <tbody>
                <tr><td>type</td><td>{doc.type}</td></tr>
                {frontmatterEntries.map(([key, value]) => (
                  <tr key={key}><td>{key}</td><td>{formatFrontmatterValue(value)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3 className="docs-meta-heading">Linked from</h3>
            {data.backlinks.length === 0 ? (
              <div className="docs-empty-note">
                {doc.archivedAt ? 'Not tracked for archived documents.' : 'No documents link here.'}
              </div>
            ) : (
              <ul className="docs-backlinks">
                {data.backlinks.map(link => (
                  <li key={`${link.sourcePath}:${link.linkKind}`}>
                    <button type="button" className="docs-link-btn" onClick={() => onOpenPath(link.sourcePath)}>
                      {link.sourcePath}
                    </button>
                    <span className="docs-row-hint">{link.linkKind}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const { path: urlPath, id: urlId } = useSearch({ strict: false }) as { path?: string; id?: string };

  const [status, setStatus] = useState<Status>('live');
  const [prefix, setPrefix] = useState('/');
  const [typeFilter, setTypeFilter] = useState('');
  const [view, setView] = useState<ListView>('tree');
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [types, setTypes] = useState<Array<{ name: string; count: number }>>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [detail, setDetail] = useState<DocResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  // ── List ──
  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ status, prefix });
    if (typeFilter) params.set('type', typeFilter);
    try {
      const res = await apiFetch(`/api/documents?${params}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { documents: DocSummary[]; types: Array<{ name: string; count: number }> };
      setDocs(data.documents);
      setTypes(data.types);
      setListError(null);
    } catch (err) {
      console.error('[DocumentsPage] failed to load documents:', err);
      setListError(err instanceof Error ? err.message : 'Failed to load documents');
    }
  }, [status, prefix, typeFilter]);

  useEffect(() => { void loadList(); }, [loadList]);

  // ── Search (debounced, server-side, paginated) ──
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [query]);

  const runSearch = useCallback(async (offset: number) => {
    if (debouncedQuery === '') return;
    const params = new URLSearchParams({
      q: debouncedQuery, status, prefix, offset: String(offset), limit: String(SEARCH_PAGE_SIZE),
    });
    try {
      const res = await apiFetch(`/api/documents/search?${params}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as SearchResponse;
      setSearch(prev => (offset > 0 && prev ? { ...data, matches: [...prev.matches, ...data.matches] } : data));
      setSearchError(null);
    } catch (err) {
      console.error('[DocumentsPage] search failed:', err);
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    }
  }, [debouncedQuery, status, prefix]);

  useEffect(() => {
    if (debouncedQuery === '') {
      setSearch(null);
      return;
    }
    void runSearch(0);
  }, [debouncedQuery, runSearch]);

  // ── Selected document ──
  // `signal` drops a response that arrives after the user has moved on, so a slow large
  // document can't overwrite the small one they opened next.
  const loadDetail = useCallback(async (target: NonNullable<Selection>, signal?: AbortSignal) => {
    try {
      const res = await apiFetch(`/api/documents/doc?${docQuery(target)}`, { signal });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as DocResponse;
      if (signal?.aborted) return;
      setDetail(data);
      setDetailError(null);
    } catch (err) {
      if (signal?.aborted) return;
      console.error('[DocumentsPage] failed to load document:', err);
      setDetail(null);
      setDetailError(err instanceof Error ? err.message : 'Failed to load document');
    }
  }, []);

  useEffect(() => {
    if (!urlPath && !urlId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    void loadDetail(urlId ? { id: urlId } : { path: urlPath! }, controller.signal);
    return () => controller.abort();
  }, [urlPath, urlId, loadDetail]);

  // Reveal the open document in the tree.
  const openPath = detail?.document.path;
  useEffect(() => {
    if (!openPath) return;
    setExpanded(prev => {
      const next = new Set(prev);
      for (const p of ancestorPrefixes(openPath)) next.add(p);
      return next;
    });
  }, [openPath]);

  function open(target: Selection) {
    void navigate({
      to: '/documents',
      search: {
        path: target !== null && 'path' in target ? target.path : undefined,
        id: target !== null && 'id' in target ? target.id : undefined,
      },
    });
  }

  function openDoc(doc: { id: string; path: string; archivedAt?: string | null; archived?: boolean }) {
    const archived = doc.archivedAt ? true : doc.archived === true;
    open(archived ? { id: doc.id } : { path: doc.path });
  }

  function toggleDir(dirPrefix: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(dirPrefix)) next.delete(dirPrefix);
      else next.add(dirPrefix);
      return next;
    });
  }

  const tree = useMemo(() => buildDocTree(docs, prefix), [docs, prefix]);
  const recent = useMemo(() => sortByUpdatedDesc(docs), [docs]);
  const selectedId = detail?.document.id ?? null;
  const prefixCrumbs = ancestorPrefixes(`${prefix}x`);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="documents" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Documents">
            <TopbarSearch placeholder="Search paths and text…" value={query} onChange={setQuery} />
            <TopbarDivider />
            <span className="topbar-meta">{docs.length} document{docs.length === 1 ? '' : 's'}</span>
          </Topbar>

          <div className="records-toolbar">
            <div className="records-toolbar-left">
              {(['live', 'archived', 'all'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  className={`records-filter-chip${status === s ? ' active' : ''}`}
                  onClick={() => setStatus(s)}
                >
                  {s === 'live' ? 'Live' : s === 'archived' ? 'Archived' : 'All'}
                </button>
              ))}
              <span className="docs-toolbar-sep" />
              <select
                className="records-filter-select"
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value)}
                aria-label="Filter by type"
              >
                <option value="">All types</option>
                {types.map(t => (
                  <option key={t.name} value={t.name}>{t.name} ({t.count})</option>
                ))}
              </select>
              <span className="docs-toolbar-sep" />
              <div className="docs-prefix-crumbs" aria-label="Path prefix">
                <button type="button" className={`docs-link-btn${prefix === '/' ? ' current' : ''}`} onClick={() => setPrefix('/')}>/</button>
                {prefixCrumbs.map(p => (
                  <button key={p} type="button" className={`docs-link-btn${p === prefix ? ' current' : ''}`} onClick={() => setPrefix(p)}>
                    {leafName(p.slice(0, -1))}/
                  </button>
                ))}
              </div>
            </div>
            <div className="records-toolbar-right">
              {(['tree', 'recent'] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  className={`records-filter-chip${view === v ? ' active' : ''}`}
                  onClick={() => setView(v)}
                >
                  {v === 'tree' ? 'Tree' : 'Recently updated'}
                </button>
              ))}
            </div>
          </div>

          <div className="docs-layout">
            <div className="docs-list">
              {listError && <div className="docs-error">{listError}</div>}
              {search ? (
                <div className="docs-search">
                  <div className="docs-search-summary">
                    {search.total} match{search.total === 1 ? '' : 'es'} in {search.documentCount} document{search.documentCount === 1 ? '' : 's'}
                  </div>
                  {searchError && <div className="docs-error">{searchError}</div>}
                  {search.matches.map((m, i) => (
                    <button
                      key={`${m.id}:${m.kind}:${m.kind === 'body' ? m.lineNumber : 0}:${i}`}
                      type="button"
                      className={`docs-search-hit${m.archived ? ' archived' : ''}`}
                      onClick={() => openDoc(m)}
                    >
                      <span className="docs-search-path">
                        {m.kind === 'path' ? <Highlight text={m.path} query={debouncedQuery} /> : m.path}
                        {m.kind === 'body' && <span className="docs-row-hint">:{m.lineNumber}</span>}
                        {m.archived && <span className="docs-badge archived">archived</span>}
                      </span>
                      {m.kind === 'body' && (
                        <span className="docs-search-context"><Highlight text={m.context} query={debouncedQuery} /></span>
                      )}
                    </button>
                  ))}
                  {search.matches.length < search.total && (
                    <button type="button" className="btn btn-secondary btn-sm docs-load-more" onClick={() => void runSearch(search.matches.length)}>
                      Load more ({search.total - search.matches.length} left)
                    </button>
                  )}
                </div>
              ) : view === 'tree' ? (
                <TreeDir
                  dir={tree}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleDir}
                  onFilter={setPrefix}
                  selectedId={selectedId}
                  onOpen={openDoc}
                />
              ) : (
                recent.map(doc => (
                  <button
                    key={doc.id}
                    type="button"
                    className={`docs-row docs-recent-row${doc.id === selectedId ? ' active' : ''}${doc.archivedAt ? ' archived' : ''}`}
                    onClick={() => openDoc(doc)}
                    title={doc.path}
                  >
                    <span className="docs-row-name">{doc.path}</span>
                    <span className="docs-row-hint">{formatTimestamp(doc.updatedAt)} · {doc.type}</span>
                  </button>
                ))
              )}
              {!search && docs.length === 0 && !listError && (
                <div className="docs-empty-note">No documents match these filters.</div>
              )}
            </div>

            <div className="docs-detail">
              {detailError ? (
                <div className="docs-error">{detailError}</div>
              ) : detail ? (
                <DocumentView data={detail} onOpenPath={path => open({ path })} />
              ) : (
                <div className="docs-empty-note docs-empty-center">
                  Pick a document to read it. Directories are path prefixes — the same
                  shape agents see through <code>doc-list</code>.
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
