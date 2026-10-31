// DocumentsPage — Memory → Documents: browse, view, search and edit the OKF working-
// document store (#1821, #1822). Navigation is path-based: directories are path prefixes
// and the frontmatter title is only a hint beside the path. Editing is whole-document
// (frontmatter and body as one OKF text) with optimistic concurrency: a save against a
// version an agent has since changed shows their text and asks — it never overwrites.
// Export downloads the store (or a folder) as an OKF zip; import previews a bundle — or
// one document edited offline — and applies only what the preview showed (#1823).

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
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
  /** Live and at or under the console size cap. */
  editable: boolean;
  editMaxBytes: number;
  /** The whole document as OKF text — present only when editable. */
  okf: string | null;
  /** On a successful mutation: things that went wrong after the change was made. */
  warnings?: string[];
}

/** Template for a new document: OKF requires frontmatter with a non-empty type. */
const NEW_DOC_TEMPLATE = '---\ntype: note\ntitle: \n---\n\n';

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

/** Send a JSON mutation; returns the status and parsed body (error bodies included). */
async function sendJson(method: 'POST' | 'PUT', url: string, payload: unknown): Promise<{ status: number; data: DocResponse & { error?: string; conflict?: boolean } }> {
  const res = await apiFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data: DocResponse & { error?: string; conflict?: boolean };
  try {
    data = await res.json() as DocResponse & { error?: string; conflict?: boolean };
  } catch {
    data = { error: `Request failed (${res.status})` } as DocResponse & { error?: string };
  }
  return { status: res.status, data };
}

function DocumentEditor({
  data, onSaved, onCancel,
}: {
  data: DocResponse;
  onSaved: (next: DocResponse) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(data.okf ?? '');
  const [baseVersion, setBaseVersion] = useState(data.document.version);
  const [conflict, setConflict] = useState<DocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bytes = new TextEncoder().encode(text).length;

  async function save(expectedVersion: number) {
    setSaving(true);
    setError(null);
    try {
      const { status, data: res } = await sendJson('PUT', '/api/documents/doc', {
        path: data.document.path, content: text, expectedVersion,
      });
      if (status === 200) {
        onSaved(res);
      } else if (status === 409 && res.conflict) {
        setConflict(res);
      } else {
        setError(res.error ?? `Save failed (${status})`);
      }
    } catch (err) {
      console.error('[DocumentsPage] save failed:', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="docs-editor">
      {conflict && (
        <div className="docs-conflict" role="alert">
          <div className="docs-conflict-title">
            This document changed after you opened it — it is now version {conflict.document.version}
            {' '}(you loaded {baseVersion}). Nothing was saved.
          </div>
          <div className="docs-conflict-label">What is there now:</div>
          <pre className="docs-conflict-text">{conflict.okf ?? conflict.document.body}</pre>
          <div className="docs-conflict-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              // Over the cap now, so there is no editable text to load — Cancel shows it read-only.
              disabled={conflict.okf === null}
              title={conflict.okf === null ? 'It is now over the console size limit — cancel to view it read-only' : undefined}
              onClick={() => {
                setText(conflict.okf ?? '');
                setBaseVersion(conflict.document.version);
                setConflict(null);
              }}
            >
              Discard my edits, load theirs
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={saving || !conflict.editable}
              onClick={() => {
                const latest = conflict.document.version;
                setBaseVersion(latest);
                setConflict(null);
                void save(latest);
              }}
            >
              Replace theirs with mine
            </button>
          </div>
        </div>
      )}
      <textarea
        className="docs-editor-text"
        value={text}
        onChange={e => setText(e.target.value)}
        spellCheck={false}
        aria-label="Document source (OKF: YAML frontmatter and markdown body)"
      />
      <div className="docs-editor-footer">
        <span className={`docs-row-hint${bytes > data.editMaxBytes ? ' docs-over' : ''}`}>
          {formatBytes(bytes)} of {formatBytes(data.editMaxBytes)} · editing version {baseVersion}
        </span>
        {error && <span className="docs-error-inline">{error}</span>}
        <span className="docs-editor-buttons">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void save(baseVersion)} disabled={saving || conflict !== null}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
      </div>
    </div>
  );
}

function DocumentView({
  data, onOpenPath, onChanged, onArchived, onRestored, onUploadEdited, onEditingChange,
}: {
  data: DocResponse;
  onOpenPath: (path: string) => void;
  /**
   * This document's content changed (a save, or a refresh after a conflict). `notices`
   * are shown by the page, which outlives this view — the view remounts per version.
   */
  onChanged: (next: DocResponse, notices?: string[]) => void;
  onArchived: (archived: DocResponse) => void;
  onRestored: (restored: DocResponse) => void;
  /** Open the import dialog to upload an offline-edited copy onto this document. */
  onUploadEdited: (path: string) => void;
  /** Reports whether the editor is open, so the page can hold off actions that reload this document. */
  onEditingChange: (editing: boolean) => void;
}) {
  const [editing, setEditingState] = useState(false);
  const setEditing = (next: boolean) => { setEditingState(next); onEditingChange(next); };
  // An unmounted view has no open editor, whatever the last toggle said — e.g. after
  // "+ New document" replaces the view and is cancelled, Import must not stay disabled.
  useEffect(() => () => onEditingChange(false), [onEditingChange]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doc = data.document;
  const live = doc.archivedAt === null;

  async function archive() {
    if (!window.confirm(`Archive ${doc.path}? It leaves the live store but stays restorable under Archived.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      const { status, data: res } = await sendJson('POST', '/api/documents/archive', { path: doc.path, expectedVersion: doc.version });
      if (status === 200) onArchived(res);
      else if (status === 409 && res.conflict) {
        onChanged(res, [`Not archived: it changed since you opened it (now version ${res.document.version}). Showing the current version.`]);
      } else setActionError(res.error ?? `Archive failed (${status})`);
    } catch (err) {
      console.error('[DocumentsPage] archive failed:', err);
      setActionError(err instanceof Error ? err.message : 'Archive failed');
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    setActionError(null);
    try {
      const { status, data: res } = await sendJson('POST', '/api/documents/restore', { id: doc.id });
      if (status === 200) onRestored(res);
      else setActionError(res.error ?? `Restore failed (${status})`);
    } catch (err) {
      console.error('[DocumentsPage] restore failed:', err);
      setActionError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  }
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
          {live && data.editable && !editing && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
          <a className="btn btn-secondary btn-sm" href={downloadHref} download>
            Download
          </a>
          {live && !editing && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void archive()} disabled={busy}>Archive</button>
          )}
          {!live && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void restore()} disabled={busy}>Restore</button>
          )}
          {actionError && <span className="docs-error-inline">{actionError}</span>}
        </div>
        {live && !data.editable && (
          <div className="docs-readonly-note">
            Read-only here: at {formatBytes(doc.byteSize)} this document is over the {formatBytes(data.editMaxBytes)} console
            editing limit. Download it, edit it offline, then{' '}
            <button type="button" className="docs-link-btn" onClick={() => onUploadEdited(doc.path)}>upload the edited copy</button>.
          </div>
        )}
      </div>

      <div className="docs-view-columns">
        {editing ? (
          <DocumentEditor
            data={data}
            onSaved={next => { setEditing(false); onChanged(next, next.warnings); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <ProgressiveBody key={`${doc.id}:${doc.version}`} chunks={data.htmlChunks} onLinkClick={handleBodyClick} />
        )}

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

function CreateDocumentPanel({
  initialDir, onCreated, onCancel,
}: {
  initialDir: string;
  onCreated: (created: DocResponse) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState(`${initialDir}untitled.md`);
  const [text, setText] = useState(NEW_DOC_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const { status, data } = await sendJson('POST', '/api/documents/doc', { path: path.trim(), content: text });
      if (status === 201) onCreated(data);
      else setError(data.error ?? `Create failed (${status})`);
    } catch (err) {
      console.error('[DocumentsPage] create failed:', err);
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="docs-view">
      <div className="docs-view-header">
        <h2 className="docs-view-path">New document</h2>
        <label className="docs-create-path">
          <span className="docs-row-hint">Path</span>
          <input value={path} onChange={e => setPath(e.target.value)} spellCheck={false} aria-label="New document path" />
        </label>
      </div>
      <div className="docs-view-columns">
        <div className="docs-editor">
          <textarea
            className="docs-editor-text"
            value={text}
            onChange={e => setText(e.target.value)}
            spellCheck={false}
            aria-label="New document source"
          />
          <div className="docs-editor-footer">
            <span className="docs-row-hint">YAML frontmatter needs a <code>type</code>. log.md and index.md are reserved.</span>
            {error && <span className="docs-error-inline">{error}</span>}
            <span className="docs-editor-buttons">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void create()} disabled={saving}>
                {saving ? 'Creating…' : 'Create'}
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Export / import ───────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="docs-modal-backdrop" onClick={onClose}>
      <div className="docs-modal" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="docs-modal-header">
          <h2 className="docs-modal-title">{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ExportDialog({ prefix, onClose }: { prefix: string; onClose: () => void }) {
  const [scope, setScope] = useState<'all' | 'folder'>(prefix === '/' ? 'all' : 'folder');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [size, setSize] = useState<{ documentCount: number; byteTotal: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = new URLSearchParams({ prefix: scope === 'all' ? '/' : prefix, includeArchived: String(includeArchived) });
  const query = params.toString();

  useEffect(() => {
    let cancelled = false;
    setSize(null);
    apiFetch(`/api/documents/export/preview?${query}`)
      .then(async res => {
        if (!res.ok) throw new Error(await errorMessage(res));
        return res.json() as Promise<{ documentCount: number; byteTotal: number }>;
      })
      .then(data => { if (!cancelled) { setSize(data); setError(null); } })
      .catch((err: unknown) => {
        console.error('[DocumentsPage] export preview failed:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not size the export');
      });
    return () => { cancelled = true; };
  }, [query]);

  return (
    <Modal title="Export documents" onClose={onClose}>
      <div className="docs-modal-body">
        <label className="docs-radio">
          <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> Whole workspace
        </label>
        {prefix !== '/' && (
          <label className="docs-radio">
            <input type="radio" checked={scope === 'folder'} onChange={() => setScope('folder')} /> Only <code>{prefix}</code>
          </label>
        )}
        <label className="docs-radio">
          <input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} /> Include archived documents
        </label>
        <div className="docs-modal-note">
          {error ?? (size
            ? `${size.documentCount} document${size.documentCount === 1 ? '' : 's'} · ${formatBytes(size.byteTotal)} — one OKF file per document plus manifest.json. The export is audited.`
            : 'Counting…')}
        </div>
      </div>
      <div className="docs-modal-footer">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        <a
          className={`btn btn-primary btn-sm${!size || size.documentCount === 0 ? ' disabled' : ''}`}
          href={`/api/documents/export?${query}`}
          download
          aria-disabled={!size || size.documentCount === 0}
          onClick={e => { if (!size || size.documentCount === 0) e.preventDefault(); else window.setTimeout(onClose, 300); }}
        >
          Download zip
        </a>
      </div>
    </Modal>
  );
}

type ImportAction = 'create' | 'update' | 'unchanged' | 'conflict';

interface ImportPlanView {
  items: Array<{ name: string; path: string; action: ImportAction; baseVersion: number | null; currentVersion: number | null; reason?: string }>;
  skipped: Array<{ name: string; reason: string }>;
  counts: Record<ImportAction | 'skipped', number>;
  token: string;
}

interface ImportResultView {
  created: string[];
  updated: string[];
  conflicts: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; error: string }>;
}

const ACTION_LABELS: Record<ImportAction, string> = {
  create: 'Create', update: 'Update', unchanged: 'Unchanged', conflict: 'Conflict',
};

function ImportDialog({ targetPath, onClose, onApplied }: { targetPath: string | null; onClose: () => void; onApplied: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState(targetPath ?? '');
  const [plan, setPlan] = useState<ImportPlanView | null>(null);
  const [result, setResult] = useState<ImportResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const single = file !== null && file.name.toLowerCase().endsWith('.md');

  async function send(mode: 'preview' | 'apply', token?: string) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const params = new URLSearchParams({ mode, format: single ? 'md' : 'zip' });
    if (single) {
      params.set('path', path.trim());
      params.set('filename', file.name);
    }
    if (token) params.set('planToken', token);
    try {
      const res = await apiFetch(`/api/documents/import?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': single ? 'text/markdown' : 'application/zip' },
        body: file,
      });
      const data = await res.json() as { plan?: ImportPlanView; result?: ImportResultView; warnings?: string[]; error?: string };
      if (data.plan) setPlan(data.plan);
      if (!res.ok) {
        setError(data.error ?? `Import failed (${res.status})`);
        return;
      }
      if (mode === 'apply' && data.result) {
        setResult(data.result);
        if (data.warnings && data.warnings.length > 0) setError(data.warnings.join(' '));
        onApplied();
      }
    } catch (err) {
      console.error('[DocumentsPage] import failed:', err);
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const writes = plan ? plan.counts.create + plan.counts.update : 0;

  return (
    <Modal title="Import documents" onClose={onClose}>
      <div className="docs-modal-body">
        <div className="docs-modal-note">
          A zip exported from here, or one document (<code>.md</code>) you downloaded and edited. Nothing is written until
          you confirm the preview. Import only creates and updates — it never archives anything missing from the file.
        </div>
        <input
          type="file"
          accept=".zip,.md,application/zip,text/markdown"
          aria-label="Bundle or document to import"
          onChange={e => { setFile(e.target.files?.[0] ?? null); setPlan(null); setResult(null); setError(null); }}
        />
        {single && (
          <label className="docs-create-path">
            <span className="docs-row-hint">Import onto</span>
            <input value={path} onChange={e => { setPath(e.target.value); setPlan(null); }} spellCheck={false} aria-label="Document path to import onto" />
          </label>
        )}
        {error && <div className="docs-error-inline">{error}</div>}
        {plan && !result && (
          <>
            <div className="kg-detail-badges">
              {(['create', 'update', 'unchanged', 'conflict'] as const).map(a => (
                <span key={a} className={`docs-badge docs-action-${a}`}>{ACTION_LABELS[a]} {plan.counts[a]}</span>
              ))}
              <span className="docs-badge">Skipped {plan.counts.skipped}</span>
            </div>
            <div className="docs-plan-list">
              {plan.items.filter(i => i.action !== 'unchanged').map(item => (
                <div key={item.name} className="docs-plan-row">
                  <span className={`docs-badge docs-action-${item.action}`}>{ACTION_LABELS[item.action]}</span>
                  <span className="docs-plan-path">{item.path}</span>
                  {item.reason && <span className="docs-row-hint">{item.reason}</span>}
                </div>
              ))}
              {plan.skipped.map(s => (
                <div key={`skip:${s.name}`} className="docs-plan-row">
                  <span className="docs-badge">Skipped</span>
                  <span className="docs-plan-path">{s.name}</span>
                  <span className="docs-row-hint">{s.reason}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {result && (
          <div className="docs-modal-note">
            Created {result.created.length}, updated {result.updated.length}
            {result.conflicts.length > 0 && `, ${result.conflicts.length} lost a race and were left as they were`}.
            {result.failed.length > 0 && (
              <div className="docs-error-inline">
                {result.failed.length} failed and were not written: {result.failed.map(f => f.path).join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="docs-modal-footer">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && (
          plan ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || writes === 0} onClick={() => void send('apply', plan.token)}>
              {writes === 0 ? 'Nothing to apply' : `Apply ${writes} change${writes === 1 ? '' : 's'}`}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !file || (single && !path.trim())} onClick={() => void send('preview')}>
              {busy ? 'Reading…' : 'Preview'}
            </button>
          )
        )}
      </div>
    </Modal>
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
  const [creating, setCreating] = useState(false);
  /** Messages about the last action on the open document; cleared when you navigate. */
  const [notices, setNotices] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  /** An open editor holds unsaved text; an import would reload the document under it. */
  const [editorOpen, setEditorOpen] = useState(false);
  /** Import dialog: null closed; otherwise the document path a single-file upload targets. */
  const [importing, setImporting] = useState<{ targetPath: string | null } | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  // Generation counters: only the newest list load, and only searches for the current
  // query, may write state — a slow stale response is dropped rather than overwriting.
  const listGen = useRef(0);
  const searchGen = useRef(0);
  /** Serializes "Load more", so two clicks can't fetch the same offset and append it twice. */
  const pageInFlight = useRef(false);

  // ── List ──
  const loadList = useCallback(async () => {
    const gen = ++listGen.current;
    const params = new URLSearchParams({ status, prefix });
    if (typeFilter) params.set('type', typeFilter);
    try {
      const res = await apiFetch(`/api/documents?${params}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { documents: DocSummary[]; types: Array<{ name: string; count: number }> };
      if (gen !== listGen.current) return;
      setDocs(data.documents);
      setTypes(data.types);
      setListError(null);
    } catch (err) {
      if (gen !== listGen.current) return;
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
    if (offset > 0) {
      if (pageInFlight.current) return;
      pageInFlight.current = true;
    }
    // A fresh search starts a new generation; a page continues the current one.
    const gen = offset === 0 ? ++searchGen.current : searchGen.current;
    const params = new URLSearchParams({
      q: debouncedQuery, status, prefix, offset: String(offset), limit: String(SEARCH_PAGE_SIZE),
    });
    try {
      const res = await apiFetch(`/api/documents/search?${params}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as SearchResponse;
      if (gen !== searchGen.current) return;
      setSearch(prev => (offset > 0 && prev ? { ...data, matches: [...prev.matches, ...data.matches] } : data));
      setSearchError(null);
    } catch (err) {
      if (gen !== searchGen.current) return;
      console.error('[DocumentsPage] search failed:', err);
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      if (offset > 0) pageInFlight.current = false;
    }
  }, [debouncedQuery, status, prefix]);

  useEffect(() => {
    if (debouncedQuery === '') {
      searchGen.current++; // drop any search still in flight for the old query
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

  // The view (and any open editor) remounts per document version; start closed.
  const detailKey = detail ? `${detail.document.id}:${detail.document.version}` : null;
  useEffect(() => { setEditorOpen(false); }, [detailKey]);

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

  /** Navigate to a document. `withNotices` carries messages about the action that led here. */
  function open(target: Selection, withNotices: string[] = []) {
    setCreating(false);
    setNotices(withNotices);
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
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setExporting(true)}>Export</button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={editorOpen}
              title={editorOpen ? 'Save or cancel your edit first' : undefined}
              onClick={() => setImporting({ targetPath: detail && !detail.document.archivedAt ? detail.document.path : null })}
            >
              Import
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New document
            </button>
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
              {creating ? (
                <CreateDocumentPanel
                  initialDir={prefix}
                  onCancel={() => setCreating(false)}
                  onCreated={created => {
                    setCreating(false);
                    setDetail(created);
                    void loadList();
                    open({ path: created.document.path }, created.warnings);
                  }}
                />
              ) : detailError ? (
                <div className="docs-error">{detailError}</div>
              ) : detail ? (
                <>
                {notices.length > 0 && (
                  <div className="docs-notices" role="status">
                    {notices.map(n => <div key={n}>{n}</div>)}
                    <button type="button" className="docs-link-btn" onClick={() => setNotices([])}>Dismiss</button>
                  </div>
                )}
                <DocumentView
                  key={`${detail.document.id}:${detail.document.version}`}
                  data={detail}
                  onOpenPath={path => open({ path })}
                  onChanged={(next, changeNotices = []) => { setDetail(next); setNotices(changeNotices); void loadList(); }}
                  onArchived={archived => {
                    setDetail(archived);
                    void loadList();
                    open({ id: archived.document.id }, archived.warnings);
                  }}
                  onRestored={restored => {
                    setDetail(restored);
                    void loadList();
                    open({ path: restored.document.path }, restored.warnings);
                  }}
                  onUploadEdited={path => setImporting({ targetPath: path })}
                  onEditingChange={setEditorOpen}
                />
                </>
              ) : (
                <div className="docs-empty-note docs-empty-center">
                  Pick a document to read it. Directories are path prefixes — the same
                  shape agents see through <code>doc-list</code>.
                </div>
              )}
            </div>
          </div>
        </main>
        {exporting && <ExportDialog prefix={prefix} onClose={() => setExporting(false)} />}
        {importing && (
          <ImportDialog
            targetPath={importing.targetPath}
            onClose={() => setImporting(null)}
            onApplied={() => {
              void loadList();
              if (urlId) void loadDetail({ id: urlId });
              else if (urlPath) void loadDetail({ path: urlPath });
            }}
          />
        )}
      </div>
    </MobileMenuContext.Provider>
  );
}
