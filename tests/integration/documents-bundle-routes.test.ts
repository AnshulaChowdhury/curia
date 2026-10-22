// Integration tests for console Documents export + import (#1823) — real Postgres, private schema.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentsRoutes } from '../../src/channels/http/routes/documents.js';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import type { BusEvent } from '../../src/bus/events.js';
import { emitOkfDocument } from '../../src/memory/okf.js';
import { DEFAULT_BUNDLE_LIMITS, readOkfBundle, type OkfBundleManifest } from '../../src/memory/okf-bundle.js';
import type { ImportPlan } from '../../src/memory/okf-bundle-import.js';
import { PRINCIPAL_EDIT_STAMP_KEY } from '../../src/agents/document-workspace.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';
import { buildRawZip } from '../helpers/raw-zip.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const SECRET = 'documents-bundle-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET };

interface ImportResponse {
  mode: string;
  plan: ImportPlan;
  result?: { created: string[]; updated: string[]; conflicts: Array<{ path: string; reason: string }> };
  error?: string;
  reason?: string;
}

describeIf('console Documents export + import (integration)', () => {
  let store: IsolatedWorkingDocsStore;
  let repo: WorkingDocsRepo;
  let app: FastifyInstance;
  const publish = vi.fn(async (_layer: string, _event: BusEvent) => {});

  beforeAll(async () => {
    store = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    repo = new WorkingDocsRepo(store.pool, createSilentLogger());
    app = Fastify();
    await app.register(cookie);
    await app.register(documentsRoutes, {
      workingDocs: repo,
      logger: createSilentLogger(),
      webAppBootstrapSecret: SECRET,
      sessions: new Map(),
      scratchTtlDays: 7,
      editMaxBytes: 64 * 1024,
      bus: { publish },
      bundleLimits: { ...DEFAULT_BUNDLE_LIMITS, maxEntries: 500, maxTotalBytes: 2 * 1024 * 1024 },
    });
  });

  afterAll(async () => {
    await app?.close();
    await store?.drop();
  });

  beforeEach(async () => {
    publish.mockReset();
    publish.mockImplementation(async () => {});
    await store.pool.query('DELETE FROM working_document_links');
    await store.pool.query('DELETE FROM working_documents');
  });

  async function seedSmall() {
    await repo.create({ path: '/projects/social-media/brief.md', type: 'brief', frontmatter: { title: 'Social' }, body: 'See [[plan]].\n' });
    await repo.create({ path: '/projects/social-media/plan.md', type: 'plan', body: 'Weekly.\n' });
    await repo.create({ path: '/projects/other/notes.md', type: 'reference', body: 'Elsewhere.\n' });
    await repo.create({ path: '/projects/social-media/old.md', type: 'analysis', body: 'Retired.\n' });
    await repo.softDelete('/projects/social-media/old.md');
  }

  async function exportZip(query = ''): Promise<{ status: number; zip: Buffer; headers: Record<string, unknown> }> {
    const res = await app.inject({ method: 'GET', url: `/api/documents/export${query}`, headers: AUTH });
    return { status: res.statusCode, zip: res.rawPayload, headers: res.headers };
  }

  async function importUpload(body: Buffer, query: string, contentType = 'application/zip'): Promise<{ status: number; body: ImportResponse }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/documents/import?${query}`,
      headers: { ...AUTH, 'content-type': contentType },
      payload: body,
    });
    return { status: res.statusCode, body: JSON.parse(res.payload) as ImportResponse };
  }

  async function previewThenApply(body: Buffer, query = 'format=zip', contentType?: string) {
    const preview = await importUpload(body, `mode=preview&${query}`, contentType);
    expect(preview.status).toBe(200);
    const applied = await importUpload(body, `mode=apply&${query}&planToken=${preview.body.plan.token}`, contentType);
    return { preview: preview.body, applied };
  }

  /** Console audit payloads, minus write-ahead `requested` records — what actually happened. */
  const exportActions = () => publish.mock.calls
    .map(([, e]) => e)
    .filter(e => e.type === 'document.console_action')
    .map(e => e.payload)
    .filter(p => !('stage' in p) || p.stage !== 'requested');

  describe('auth', () => {
    it.each([
      ['GET', '/api/documents/export'],
      ['GET', '/api/documents/export/preview'],
      ['POST', '/api/documents/import?mode=preview'],
    ] as const)('rejects an unauthenticated %s %s', async (method, url) => {
      const res = await app.inject({ method, url, headers: { 'content-type': 'application/zip' }, payload: method === 'POST' ? Buffer.from('x') : undefined });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('export', () => {
    it('produces OKF entries at store paths plus a manifest', async () => {
      await seedSmall();
      const { status, zip, headers } = await exportZip();
      expect(status).toBe(200);
      expect(headers['content-type']).toBe('application/zip');
      expect(String(headers['content-disposition'])).toMatch(/attachment; filename="curia-documents-all-\d{8}-\d{4}\.zip"/);

      const bundle = await readOkfBundle(zip);
      expect(bundle.documents.map(d => d.name).sort()).toEqual([
        'projects/other/notes.md', 'projects/social-media/brief.md', 'projects/social-media/plan.md',
      ]);
      const manifest = bundle.manifest as OkfBundleManifest;
      expect(manifest).toMatchObject({ scope: '/', includeArchived: false, documentCount: 3 });
      for (const d of manifest.documents) {
        expect(d).toEqual({ entry: expect.any(String), id: expect.any(String), path: `/${d.entry}`, version: 1, updatedAt: expect.any(String), archivedAt: null });
      }
    });

    it('uses the same serialization as the single-document download', async () => {
      await seedSmall();
      const { zip } = await exportZip();
      const fromBundle = (await readOkfBundle(zip)).documents.find(d => d.path === '/projects/social-media/brief.md')!;
      const single = await app.inject({ method: 'GET', url: '/api/documents/download?path=/projects/social-media/brief.md', headers: AUTH });
      expect(fromBundle.content).toBe(single.payload);
    });

    it('limits a subtree export to that subtree', async () => {
      await seedSmall();
      const { zip } = await exportZip('?prefix=/projects/social-media');
      const bundle = await readOkfBundle(zip);
      expect(bundle.documents.map(d => d.path).sort()).toEqual(['/projects/social-media/brief.md', '/projects/social-media/plan.md']);
      expect(bundle.manifest?.scope).toBe('/projects/social-media/');
    });

    it('includes archived rows only when asked, under .archived/', async () => {
      await seedSmall();
      const without = await readOkfBundle((await exportZip()).zip);
      expect(without.skipped).toEqual([]);
      const withArchived = await readOkfBundle((await exportZip('?includeArchived=true')).zip);
      expect(withArchived.skipped.map(s => s.name)).toEqual([expect.stringMatching(/^\.archived\/[0-9a-f-]+\/projects\/social-media\/old\.md$/)]);
      expect(withArchived.manifest?.documentCount).toBe(4);
    });

    it('previews the count and byte total, and audits the export with them', async () => {
      await seedSmall();
      const preview = await app.inject({ method: 'GET', url: '/api/documents/export/preview?prefix=/projects/social-media/', headers: AUTH });
      const sized = JSON.parse(preview.payload) as { documentCount: number; byteTotal: number };
      expect(sized.documentCount).toBe(2);

      await exportZip('?prefix=/projects/social-media/');
      expect(exportActions()).toEqual([expect.objectContaining({
        action: 'export', scope: '/projects/social-media/', includeArchived: false, documentCount: 2, byteTotal: sized.byteTotal,
      })]);
    });

    it('refuses to export when the audit entry cannot be written', async () => {
      await seedSmall();
      publish.mockRejectedValueOnce(new Error('audit down'));
      const { status } = await exportZip();
      expect(status).toBe(500);
    });

    it('streams a production-scale store (105 docs, ~450 kB, one 211 kB document)', async () => {
      await repo.create({ path: '/projects/social-media/activity-log.md', type: 'log', body: `${'## [2026-09-01] post | update\n\nPosted.\n\n'.repeat(5200)}` });
      for (let i = 0; i < 104; i++) {
        await repo.create({ path: `/projects/p${i % 30}/doc-${i}.md`, type: 'brief', body: `${'Line of project notes.\n'.repeat(100)}` });
      }
      const { status, zip } = await exportZip();
      expect(status).toBe(200);
      const bundle = await readOkfBundle(zip);
      expect(bundle.documents).toHaveLength(105);
      const log = bundle.documents.find(d => d.path === '/projects/social-media/activity-log.md')!;
      expect(Buffer.byteLength(log.body)).toBeGreaterThan(200_000);
    });
  });

  describe('import', () => {
    it('dry-runs an accurate summary and writes nothing', async () => {
      await seedSmall();
      const zip = (await exportZip()).zip;
      // Change the store so the bundle has one create, one update and some unchanged.
      await repo.softDelete('/projects/other/notes.md');
      const before = (await store.pool.query('SELECT id, version, updated_at, archived_at FROM working_documents ORDER BY id')).rows;
      publish.mockClear(); // the export above was audited; the preview must not be

      const { status, body } = await importUpload(zip, 'mode=preview&format=zip');

      expect(status).toBe(200);
      expect(body.plan.counts).toEqual({ create: 1, update: 0, unchanged: 2, conflict: 0, skipped: 0 });
      expect(body.plan.items.find(i => i.action === 'create')?.path).toBe('/projects/other/notes.md');
      expect((await store.pool.query('SELECT id, version, updated_at, archived_at FROM working_documents ORDER BY id')).rows).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
    });

    it('applies exactly the previewed changes', async () => {
      await seedSmall();
      const brief = (await repo.read('/projects/social-media/brief.md'))!;
      const zip = buildRawZip([
        { name: 'manifest.json', data: JSON.stringify({ format: 'curia-okf-bundle', formatVersion: 1, documents: [{ entry: 'projects/social-media/brief.md', id: brief.id, path: '/projects/social-media/brief.md', version: brief.version, updatedAt: brief.updatedAt, archivedAt: null }] }) },
        { name: 'projects/social-media/brief.md', data: emitOkfDocument({ type: 'brief', frontmatter: { title: 'Social v2' }, body: 'See [[plan]] again.\n' }) },
        { name: 'projects/new/idea.md', data: emitOkfDocument({ type: 'note', body: 'New idea.\n' }) },
        { name: 'projects/social-media/plan.md', data: emitOkfDocument({ type: 'plan', body: 'Weekly.\n' }) },
      ]);

      const { preview, applied } = await previewThenApply(zip);

      expect(preview.plan.counts).toMatchObject({ create: 1, update: 1, unchanged: 1, conflict: 0 });
      expect(applied.status).toBe(200);
      expect(applied.body.result).toEqual({ created: ['/projects/new/idea.md'], updated: ['/projects/social-media/brief.md'], conflicts: [], failed: [] });
      const updated = (await repo.read('/projects/social-media/brief.md'))!;
      expect(updated.frontmatter).toEqual({ title: 'Social v2' });
      expect(updated.version).toBe(brief.version + 1);
      expect((await repo.read('/projects/social-media/plan.md'))!.version).toBe(1);
      // A bundle import is a faithful restore: no provenance stamp, no log.md lines.
      expect(updated.frontmatter[PRINCIPAL_EDIT_STAMP_KEY]).toBeUndefined();
      expect(await repo.read('/projects/new/log.md')).toBeNull();
      expect(exportActions()).toEqual([expect.objectContaining({ action: 'import', scope: 'bundle', created: 1, updated: 1, unchanged: 1, conflicts: 0 })]);
    });

    it('refuses to apply when the store moved after the preview', async () => {
      await seedSmall();
      const zip = buildRawZip([{ name: 'projects/new/idea.md', data: emitOkfDocument({ type: 'note', body: 'x\n' }) }]);
      const preview = await importUpload(zip, 'mode=preview&format=zip');
      await repo.create({ path: '/projects/new/idea.md', type: 'note', body: 'someone else\n' });

      const applied = await importUpload(zip, `mode=apply&format=zip&planToken=${preview.body.plan.token}`);

      expect(applied.status).toBe(409);
      expect(applied.body.reason).toBe('plan_changed');
      expect((await repo.read('/projects/new/idea.md'))!.body).toBe('someone else\n');
    });

    it('reports a conflict, not an overwrite, when the manifest version is behind the store', async () => {
      await seedSmall();
      const zip = (await exportZip()).zip;
      await repo.update('/projects/social-media/plan.md', { body: 'Agent changed this.\n', expectedVersion: 1 });
      const tampered = await readOkfBundle(zip);
      const rebuilt = buildRawZip([
        { name: 'manifest.json', data: JSON.stringify(tampered.manifest) },
        ...tampered.documents.map(d => ({ name: d.name, data: d.name.endsWith('plan.md') ? emitOkfDocument({ type: 'plan', body: 'Offline edit.\n' }) : d.content })),
      ]);

      const { preview, applied } = await previewThenApply(rebuilt);

      expect(preview.plan.items.find(i => i.path === '/projects/social-media/plan.md')).toMatchObject({
        action: 'conflict', reason: 'changed since export (bundle v1, store v2)',
      });
      expect(applied.body.result?.updated).toEqual([]);
      expect((await repo.read('/projects/social-media/plan.md'))!.body).toBe('Agent changed this.\n');
    });

    it('conflicts when a new document took the path at the same version (#1823 review)', async () => {
      await repo.create({ path: '/projects/a/brief.md', type: 'brief', body: 'original\n' });
      const zip = (await exportZip()).zip;
      await repo.softDelete('/projects/a/brief.md');
      await repo.create({ path: '/projects/a/brief.md', type: 'brief', body: 'unrelated new doc\n' });
      const exported = await readOkfBundle(zip);
      const edited = buildRawZip([
        { name: 'manifest.json', data: JSON.stringify(exported.manifest) },
        { name: 'projects/a/brief.md', data: emitOkfDocument({ type: 'brief', body: 'offline edit of the original\n' }) },
      ]);

      const { preview, applied } = await previewThenApply(edited);

      expect(preview.plan.items[0]).toMatchObject({ action: 'conflict', reason: 'a different document now lives at this path' });
      expect(applied.body.result?.updated).toEqual([]);
      expect((await repo.read('/projects/a/brief.md'))!.body).toBe('unrelated new doc\n');
    });

    it('never archives or deletes documents absent from the bundle', async () => {
      await seedSmall();
      const zip = buildRawZip([{ name: 'projects/only/one.md', data: emitOkfDocument({ type: 'note', body: 'x\n' }) }]);
      await previewThenApply(zip);
      const live = (await repo.listSummaries({ status: 'live' })).map(d => d.path).sort();
      expect(live).toEqual([
        '/projects/only/one.md', '/projects/other/notes.md', '/projects/social-media/brief.md', '/projects/social-media/plan.md',
      ]);
    });

    describe('hard guards — one test per guard, none writes outside the workspace', () => {
      const valid = emitOkfDocument({ type: 'note', body: 'x\n' });
      const cases: Array<[string, string, string, RegExp]> = [
        ['../ traversal', '../../etc/evil.md', valid, /path traversal/],
        ['an absolute path', '/etc/evil.md', valid, /absolute path/],
        ['a non-.md entry', 'projects/x/script.sh', 'echo pwned', /not a \.md document/],
        ['a file without valid OKF frontmatter', 'projects/x/plain.md', 'just text', /invalid OKF/],
      ];
      it.each(cases)('skips %s with a per-entry reason', async (_label, name, data, reason) => {
        const zip = buildRawZip([{ name, data }, { name: 'projects/x/fine.md', data: valid }]);
        const { preview, applied } = await previewThenApply(zip);
        expect(preview.plan.skipped).toEqual([{ name, reason: expect.stringMatching(reason) }]);
        expect(applied.body.result?.created).toEqual(['/projects/x/fine.md']);
        const paths = (await repo.listSummaries({ status: 'all' })).map(d => d.path);
        expect(paths).toEqual(['/projects/x/fine.md']);
      });

      it('enforces the entry-count cap during extraction', async () => {
        const zip = buildRawZip(Array.from({ length: 501 }, (_, i) => ({ name: `p/${i}.md`, data: valid })));
        const res = await importUpload(zip, 'mode=preview&format=zip');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/501 entries — the limit is 500/);
      });

      it('enforces the uncompressed-size cap during extraction', async () => {
        const zip = buildRawZip([{ name: 'p/bomb.md', data: Buffer.alloc(3 * 1024 * 1024, 0x61), declaredSize: 100 }]);
        const res = await importUpload(zip, 'mode=preview&format=zip');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/uncompressed size limit/);
        expect(await repo.listSummaries({ status: 'all' })).toEqual([]);
      });
    });

    describe('single document — the over-cap offline editing loop', () => {
      it('updates the document in place from its edited download', async () => {
        await repo.create({ path: '/projects/social-media/activity-log.md', type: 'log', body: 'old log\n' });
        const download = await app.inject({ method: 'GET', url: '/api/documents/download?path=/projects/social-media/activity-log.md', headers: AUTH });
        const filename = /filename="([^"]+)"/.exec(String(download.headers['content-disposition']))![1]!;
        expect(filename).toMatch(/^activity-log\.v1\.[0-9a-f]{8}\.md$/);
        const edited = Buffer.from(download.payload.replace('old log', 'edited offline'), 'utf8');

        const { preview, applied } = await previewThenApply(
          edited,
          `format=md&path=/projects/social-media/activity-log.md&filename=${filename}`,
          'text/markdown',
        );

        expect(preview.plan.items).toEqual([expect.objectContaining({ action: 'update', baseVersion: 1, currentVersion: 1 })]);
        expect(applied.status).toBe(200);
        const row = (await repo.read('/projects/social-media/activity-log.md'))!;
        expect(row.body).toBe('edited offline\n');
        expect(row.version).toBe(2);
        // An offline edit is still the principal's edit: stamped and logged.
        expect(row.frontmatter[PRINCIPAL_EDIT_STAMP_KEY]).toBeDefined();
        expect((await repo.read('/projects/social-media/log.md'))!.body).toMatch(/console-import/);
        expect(exportActions()).toEqual([expect.objectContaining({ action: 'import', scope: '/projects/social-media/activity-log.md', updated: 1 })]);
      });

      it('conflicts when the store moved on since the download', async () => {
        await repo.create({ path: '/projects/a/log-ish.md', type: 'log', body: 'v1\n' });
        await repo.update('/projects/a/log-ish.md', { body: 'agent v2\n', expectedVersion: 1 });
        const { preview } = await previewThenApply(
          Buffer.from(emitOkfDocument({ type: 'log', body: 'offline from v1\n' })),
          'format=md&path=/projects/a/log-ish.md&filename=log-ish.v1.md',
          'text/markdown',
        );
        expect(preview.plan.items[0]).toMatchObject({ action: 'conflict' });
        expect((await repo.read('/projects/a/log-ish.md'))!.body).toBe('agent v2\n');
      });

      it('conflicts rather than guessing when the filename lost its version', async () => {
        await repo.create({ path: '/projects/a/doc.md', type: 'note', body: 'v1\n' });
        const res = await importUpload(
          Buffer.from(emitOkfDocument({ type: 'note', body: 'edited\n' })),
          'mode=preview&format=md&path=/projects/a/doc.md&filename=doc-renamed.md',
          'text/markdown',
        );
        expect(res.body.plan.items[0]).toMatchObject({ action: 'conflict', reason: expect.stringMatching(/no base version/) });
      });
    });

    it('records the import before writing, and refuses to start if it cannot (#2236 review)', async () => {
      const zip = buildRawZip([{ name: 'projects/new/idea.md', data: emitOkfDocument({ type: 'note', body: 'x\n' }) }]);
      const preview = await importUpload(zip, 'mode=preview&format=zip');
      publish.mockRejectedValueOnce(new Error('audit down'));
      const refused = await importUpload(zip, `mode=apply&format=zip&planToken=${preview.body.plan.token}`);
      expect(refused.status).toBe(500);
      expect(refused.body.error).toMatch(/Nothing was imported/);
      expect(await repo.read('/projects/new/idea.md')).toBeNull();

      publish.mockClear();
      const applied = await importUpload(zip, `mode=apply&format=zip&planToken=${preview.body.plan.token}`);
      expect(applied.status).toBe(200);
      const stages = publish.mock.calls.map(([, e]) => (e.payload as { stage?: string }).stage);
      expect(stages).toEqual(['requested', 'completed']);
    });

    it('rejects an unauthenticated upload before buffering it (#2236 review)', async () => {
      // Larger than the 32 MiB import limit: a 413 would mean the body was read first.
      const res = await app.inject({
        method: 'POST', url: '/api/documents/import?mode=preview&format=zip',
        headers: { 'content-type': 'application/zip' },
        payload: Buffer.alloc(33 * 1024 * 1024),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an upload that is not a zip', async () => {
      const res = await importUpload(Buffer.from('not a zip'), 'mode=preview&format=zip');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a valid zip/);
    });
  });
});
