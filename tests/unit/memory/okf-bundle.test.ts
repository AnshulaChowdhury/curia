import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  bundleEntryName,
  DEFAULT_BUNDLE_LIMITS,
  OkfBundleError,
  readOkfBundle,
  unsafeEntryNameReason,
  baseFromDownloadName,
  writeOkfBundle,
} from '../../../src/memory/okf-bundle.js';
import { applyImportPlan, planImport, sameDocumentContent } from '../../../src/memory/okf-bundle-import.js';
import { emitOkfDocument } from '../../../src/memory/okf.js';
import type { WorkingDocRow } from '../../../src/db/working-docs-repo.js';
import { buildRawZip } from '../../helpers/raw-zip.js';

const okf = (type: string, body: string, frontmatter: Record<string, unknown> = {}) => emitOkfDocument({ type, frontmatter, body });

function row(path: string, overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: `id-${path}`, path, type: 'brief', frontmatter: {}, body: `body of ${path}\n`, version: 1,
    sectionVersions: {}, byteSize: 40, taskId: null, conversationId: null, agentId: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', archivedAt: null,
    ...overrides,
  };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('unsafeEntryNameReason', () => {
  it.each([
    ['projects/x/brief.md', null],
    ['../etc/passwd.md', 'path traversal (..)'],
    ['projects/../../x.md', 'path traversal (..)'],
    ['/etc/x.md', 'absolute path'],
    ['C:/x.md', 'absolute path'],
    ['projects\\..\\x.md', 'backslash in path'],
    ['projects//x.md', 'empty or "." path segment'],
    ['projects/./x.md', 'empty or "." path segment'],
    ['a\u0000b.md', 'control character in path'],
  ])('%s → %s', (name, reason) => {
    expect(unsafeEntryNameReason(name)).toBe(reason);
  });
});

describe('baseFromDownloadName', () => {
  it('reads the version and row-id fragment single-document downloads carry', () => {
    expect(baseFromDownloadName('activity-log.v57.3F2A9C1D.md')).toEqual({ version: 57, idPrefix: '3f2a9c1d' });
    expect(baseFromDownloadName('activity-log.v57.md')).toEqual({ version: 57 });
    expect(baseFromDownloadName('activity-log.md')).toBeNull();
    expect(baseFromDownloadName('notes.v2.md.txt')).toBeNull();
  });
});

describe('bundleEntryName', () => {
  it('maps live rows to their path and archived rows under .archived/<id>/', () => {
    expect(bundleEntryName({ id: 'a', path: '/projects/x/brief.md', archivedAt: null })).toBe('projects/x/brief.md');
    expect(bundleEntryName({ id: 'a', path: '/projects/x/brief.md', archivedAt: '2026-10-01' })).toBe('.archived/a/projects/x/brief.md');
  });
});

describe('writeOkfBundle → readOkfBundle', () => {
  it('round-trips documents and writes a manifest last', async () => {
    const docs = [row('/projects/x/brief.md'), row('/scratch/c/n.md', { body: 'no trailing newline' })];
    const loadDocument = vi.fn(async (id: string) => docs.find(d => d.id === id) ?? null);
    const stream = writeOkfBundle({
      documents: docs, loadDocument, toOkf: d => okf(d.type, d.body, d.frontmatter), scope: '/', includeArchived: false,
      now: new Date('2026-10-21T00:00:00Z'),
    });
    const zip = await collect(stream);
    const contents = await readOkfBundle(zip);

    expect(contents.skipped).toEqual([]);
    expect(contents.documents.map(d => [d.path, d.body])).toEqual([
      ['/projects/x/brief.md', 'body of /projects/x/brief.md\n'],
      ['/scratch/c/n.md', 'no trailing newline'],
    ]);
    expect(contents.manifest).toMatchObject({
      format: 'curia-okf-bundle', exportedAt: '2026-10-21T00:00:00.000Z', documentCount: 2,
      documents: [
        { entry: 'projects/x/brief.md', id: 'id-/projects/x/brief.md', path: '/projects/x/brief.md', version: 1, archivedAt: null },
        { entry: 'scratch/c/n.md', id: 'id-/scratch/c/n.md', path: '/scratch/c/n.md', version: 1, archivedAt: null },
      ],
    });
  });

  it('reads each document only when the writer reaches it', async () => {
    // Incompressible bodies, so the output stream's buffer fills and backpressure applies.
    const docs = Array.from({ length: 20 }, (_, i) => row(`/p/doc-${i}.md`, { body: randomBytes(50_000).toString('base64') }));
    const loadDocument = vi.fn(async (id: string) => docs.find(d => d.id === id) ?? null);
    const stream = writeOkfBundle({ documents: docs, loadDocument, toOkf: d => okf(d.type, d.body), scope: '/', includeArchived: false });

    await new Promise(resolve => setTimeout(resolve, 20));
    // Nothing consumed yet: the writer is a few stream buffers ahead, not through the store.
    expect(loadDocument.mock.calls.length).toBeLessThanOrEqual(4);
    await collect(stream);
    expect(loadDocument).toHaveBeenCalledTimes(20);
  });

  it('fails the stream when a document vanished mid-export', async () => {
    const stream = writeOkfBundle({
      documents: [row('/p/a.md')], loadDocument: async () => null, toOkf: () => '', scope: '/', includeArchived: false,
    });
    await expect(collect(stream)).rejects.toThrow(/disappeared during export/);
  });
});

describe('readOkfBundle guards', () => {
  const good = okf('brief', 'hello\n');

  it('skips unsafe, non-.md, invalid and archived entries with a reason each', async () => {
    const zip = buildRawZip([
      { name: 'projects/ok.md', data: good },
      { name: '../escape.md', data: good },
      { name: '/abs/x.md', data: good },
      { name: 'projects/run.sh', data: 'echo hi' },
      { name: 'projects/bad.md', data: 'no frontmatter here' },
      { name: 'projects/untyped.md', data: '---\ntitle: x\n---\nbody' },
      { name: '.archived/123/projects/old.md', data: good },
      { name: 'projects/link.md', data: 'target', mode: 0o120777 },
      { name: 'projects/', data: '' },
      { name: 'projects/index.md', data: good },
    ]);
    const { documents, skipped } = await readOkfBundle(zip);
    expect(documents.map(d => d.path)).toEqual(['/projects/ok.md']);
    expect(Object.fromEntries(skipped.map(s => [s.name, s.reason]))).toEqual({
      '../escape.md': 'path traversal (..)',
      '/abs/x.md': 'absolute path',
      'projects/run.sh': 'not a .md document',
      'projects/bad.md': expect.stringMatching(/^invalid OKF: .*frontmatter/),
      'projects/untyped.md': expect.stringMatching(/^invalid OKF: .*type/),
      '.archived/123/projects/old.md': expect.stringMatching(/^archived in the bundle/),
      'projects/link.md': 'symbolic link',
      'projects/index.md': 'index.md is a generated projection, not a stored document',
    });
  });

  it('rejects a bundle over the entry-count cap before extracting anything', async () => {
    const zip = buildRawZip(Array.from({ length: 6 }, (_, i) => ({ name: `p/${i}.md`, data: good })));
    await expect(readOkfBundle(zip, { ...DEFAULT_BUNDLE_LIMITS, maxEntries: 5 })).rejects.toThrow(/6 entries — the limit is 5/);
  });

  it('stops inflating a zip bomb at the cap, whatever its header claims', async () => {
    const bomb = Buffer.alloc(5 * 1024 * 1024, 0x61);
    const zip = buildRawZip([{ name: 'p/bomb.md', data: bomb, declaredSize: 10 }]);
    await expect(readOkfBundle(zip, { ...DEFAULT_BUNDLE_LIMITS, maxEntryBytes: 1024 * 1024 }))
      .rejects.toThrow(OkfBundleError);
  });

  it('enforces the total uncompressed budget across entries', async () => {
    const chunk = `${good}${'x'.repeat(60_000)}`;
    const zip = buildRawZip(Array.from({ length: 4 }, (_, i) => ({ name: `p/${i}.md`, data: chunk })));
    await expect(readOkfBundle(zip, { ...DEFAULT_BUNDLE_LIMITS, maxTotalBytes: 150_000 })).rejects.toThrow(/uncompressed/);
  });

  it('rejects something that is not a zip, and a malformed manifest', async () => {
    await expect(readOkfBundle(Buffer.from('plain text'))).rejects.toThrow(/not a valid zip/);
    await expect(readOkfBundle(buildRawZip([{ name: 'manifest.json', data: '{"format":"other","documents":[]}' }])))
      .rejects.toThrow(/not a curia-okf-bundle manifest/);
  });
});

describe('planImport', () => {
  const entry = (path: string, body: string, frontmatter: Record<string, unknown> = {}) => ({
    name: path.slice(1), path, content: okf('brief', body, frontmatter), type: 'brief', frontmatter, body,
  });

  it('classifies create / update / unchanged / conflict', async () => {
    const store = new Map<string, WorkingDocRow>([
      ['/p/same.md', row('/p/same.md', { body: 'same\n', frontmatter: { b: 1, a: 2 } })],
      ['/p/edit.md', row('/p/edit.md', { body: 'old\n', version: 3 })],
      ['/p/moved.md', row('/p/moved.md', { body: 'agent changed\n', version: 5 })],
      ['/p/nobase.md', row('/p/nobase.md', { body: 'theirs\n' })],
    ]);
    const plan = await planImport(
      [
        entry('/p/new.md', 'new\n'),
        entry('/p/same.md', 'same\n', { a: 2, b: 1 }),
        entry('/p/edit.md', 'edited offline\n'),
        entry('/p/moved.md', 'stale copy\n'),
        entry('/p/nobase.md', 'mine\n'),
      ],
      new Map([['/p/same.md', { version: 1 }], ['/p/edit.md', { version: 3, id: 'id-/p/edit.md' }], ['/p/moved.md', { version: 4 }]]),
      [{ name: 'x.txt', reason: 'not a .md document' }],
      { read: async (p: string) => store.get(p) ?? null },
    );
    expect(plan.items.map(i => [i.path, i.action])).toEqual([
      ['/p/new.md', 'create'],
      ['/p/same.md', 'unchanged'],
      ['/p/edit.md', 'update'],
      ['/p/moved.md', 'conflict'],
      ['/p/nobase.md', 'conflict'],
    ]);
    expect(plan.items[3]!.reason).toBe('changed since export (bundle v4, store v5)');
    expect(plan.counts).toEqual({ create: 1, update: 1, unchanged: 1, conflict: 2, skipped: 1 });
  });

  it('produces a token that moves when the store moves', async () => {
    const store = new Map([['/p/a.md', row('/p/a.md', { body: 'old\n' })]]);
    const repo = { read: async (p: string) => store.get(p) ?? null };
    const docs = [entry('/p/a.md', 'new\n')];
    const first = await planImport(docs, new Map([['/p/a.md', { version: 1 }]]), [], repo);
    expect((await planImport(docs, new Map([['/p/a.md', { version: 1 }]]), [], repo)).token).toBe(first.token);
    store.set('/p/a.md', row('/p/a.md', { body: 'agent\n', version: 2 }));
    expect((await planImport(docs, new Map([['/p/a.md', { version: 1 }]]), [], repo)).token).not.toBe(first.token);
  });

  it('conflicts when a different row now holds the path at the same version (#1823 review)', async () => {
    // Exported v1 of one row; that row was archived and an agent created a new v1 there.
    const repo = { read: async () => row('/p/a.md', { id: 'new-row', body: 'agent\n', version: 1 }) };
    const docs = [entry('/p/a.md', 'stale copy\n')];
    const byId = await planImport(docs, new Map([['/p/a.md', { version: 1, id: 'old-row' }]]), [], repo);
    expect(byId.items[0]).toMatchObject({ action: 'conflict', reason: 'a different document now lives at this path' });
    const byPrefix = await planImport(docs, new Map([['/p/a.md', { version: 1, idPrefix: 'deadbeef' }]]), [], repo);
    expect(byPrefix.items[0]!.action).toBe('conflict');
  });

  it('reports a failed write per document and keeps going (#1823 review)', async () => {
    const created: string[] = [];
    const docs = [entry('/p/boom.md', 'x\n'), entry('/p/fine.md', 'y\n')];
    const plan = await planImport(docs, new Map(), [], { read: async () => null });
    const result = await applyImportPlan(plan, docs, {
      read: async () => null,
      update: async () => { throw new Error('unused'); },
      create: async (p) => {
        if (p.path === '/p/boom.md') throw new Error('disk full');
        created.push(p.path);
        return row(p.path);
      },
    });
    expect(result).toEqual({ created: ['/p/fine.md'], updated: [], conflicts: [], failed: [{ path: '/p/boom.md', error: 'disk full' }] });
  });

  it('compares frontmatter regardless of key order', () => {
    expect(sameDocumentContent(
      { type: 't', body: 'b', frontmatter: { x: { b: 1, a: [1, { d: 1, c: 2 }] } } },
      { type: 't', body: 'b', frontmatter: { x: { a: [1, { c: 2, d: 1 }], b: 1 } } },
    )).toBe(true);
  });
});
