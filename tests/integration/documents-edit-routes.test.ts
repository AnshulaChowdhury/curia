// Integration tests for console Documents editing (#1822) — real Postgres, private schema.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentsRoutes } from '../../src/channels/http/routes/documents.js';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import type { BusEvent } from '../../src/bus/events.js';
import { emitOkfDocument } from '../../src/memory/okf.js';
import { PRINCIPAL_EDIT_STAMP_KEY } from '../../src/agents/document-workspace.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const SECRET = 'documents-edit-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET };
const CAP = 4096;

interface DetailResponse {
  document: { id: string; path: string; type: string; version: number; frontmatter: Record<string, unknown>; body: string; archivedAt: string | null };
  editable: boolean;
  okf: string | null;
  conflict?: boolean;
  reason?: string;
  error?: string;
}

describeIf('console Documents editing (integration)', () => {
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
      editMaxBytes: CAP,
      bus: { publish },
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

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    const res = await app.inject({ method, url, headers: AUTH, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: JSON.parse(res.payload) as DetailResponse };
  }

  /** Audit trail as `stage:action`, in publish order. */
  const auditTrail = () => publish.mock.calls.map(([, event]) =>
    (event.type === 'document.console_action' && 'stage' in event.payload ? `${event.payload.stage}:${event.payload.action}` : event.type));
  /** Completed actions only — what actually changed. */
  const auditActions = () => auditTrail().filter(a => a.startsWith('completed:')).map(a => a.slice('completed:'.length));

  async function logBody(dir: string): Promise<string> {
    return (await repo.read(`${dir}log.md`))?.body ?? '';
  }

  describe('auth', () => {
    it.each([
      ['POST', '/api/documents/doc'],
      ['PUT', '/api/documents/doc'],
      ['POST', '/api/documents/archive'],
      ['POST', '/api/documents/restore'],
    ] as const)('rejects an unauthenticated %s %s', async (method, url) => {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unauthenticated write before reading its body (#2236 review)', async () => {
      // Over the body limit: a 413 would mean the body was read before auth ran.
      const res = await app.inject({
        method: 'PUT', url: '/api/documents/doc',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ content: 'x'.repeat(CAP * 8) }),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('save', () => {
    it('persists body and frontmatter, bumps version, re-extracts links, logs, stamps and audits', async () => {
      await repo.create({ path: '/projects/p/target.md', type: 'reference', body: 'target\n' });
      await repo.create({ path: '/projects/p/brief.md', type: 'brief', frontmatter: { title: 'Old' }, body: 'No links yet.\n' });
      const loaded = await call('GET', '/api/documents/doc?path=/projects/p/brief.md');
      expect(loaded.body.editable).toBe(true);
      expect(loaded.body.okf).toContain('title: Old');

      const content = emitOkfDocument({ type: 'brief', frontmatter: { title: 'New', tags: ['a'] }, body: 'Now see [[target]].\n' });
      const saved = await call('PUT', '/api/documents/doc', { path: '/projects/p/brief.md', content, expectedVersion: 1 });

      expect(saved.status).toBe(200);
      expect(saved.body.document.version).toBe(2);
      const row = (await repo.read('/projects/p/brief.md'))!;
      expect(row.body).toBe('Now see [[target]].\n');
      expect(row.frontmatter).toMatchObject({ title: 'New', tags: ['a'] });
      expect(typeof row.frontmatter[PRINCIPAL_EDIT_STAMP_KEY]).toBe('string');
      expect(await repo.getBacklinks('/projects/p/target.md')).toEqual([
        { sourcePath: '/projects/p/brief.md', targetPath: '/projects/p/target.md', linkKind: 'wikilink' },
      ]);
      expect(await logBody('/projects/p/')).toMatch(/console-update \| principal edited brief\.md in the console/);
      expect(auditActions()).toEqual(['update']);
      expect(publish.mock.calls.every(([layer]) => layer === 'system')).toBe(true);
      expect(auditTrail()).toEqual(['requested:update', 'completed:update']);
    });

    it('persists a frontmatter-only edit and re-runs link extraction', async () => {
      await repo.create({ path: '/projects/p/target.md', type: 'reference', body: 'target\n' });
      await repo.create({ path: '/projects/p/brief.md', type: 'brief', body: 'See [t](target.md).\n' });
      // Drop the link index row so only a fresh extraction can bring it back.
      await store.pool.query('DELETE FROM working_document_links');

      const content = emitOkfDocument({ type: 'plan', frontmatter: { title: 'Retitled' }, body: 'See [t](target.md).\n' });
      const saved = await call('PUT', '/api/documents/doc', { path: '/projects/p/brief.md', content, expectedVersion: 1 });

      expect(saved.status).toBe(200);
      const row = (await repo.read('/projects/p/brief.md'))!;
      expect(row.type).toBe('plan');
      expect(row.frontmatter.title).toBe('Retitled');
      expect(row.body).toBe('See [t](target.md).\n');
      expect((await repo.getBacklinks('/projects/p/target.md')).map(l => l.linkKind)).toEqual(['markdown']);
    });

    it('returns a conflict with the current text when an agent wrote in between, and keeps the agent text', async () => {
      await repo.create({ path: '/projects/p/brief.md', type: 'brief', body: 'v1 text\n' });
      const loaded = await call('GET', '/api/documents/doc?path=/projects/p/brief.md');
      // Concurrent agent write between load and save.
      await repo.update('/projects/p/brief.md', { body: 'agent wrote this\n', expectedVersion: loaded.body.document.version });

      const content = emitOkfDocument({ type: 'brief', body: 'principal edit\n' });
      const saved = await call('PUT', '/api/documents/doc', {
        path: '/projects/p/brief.md', content, expectedVersion: loaded.body.document.version,
      });

      expect(saved.status).toBe(409);
      expect(saved.body.conflict).toBe(true);
      expect(saved.body.document.body).toBe('agent wrote this\n');
      expect(saved.body.document.version).toBe(2);
      expect((await repo.read('/projects/p/brief.md'))!.body).toBe('agent wrote this\n');
      expect(auditActions()).toEqual([]);
    });

    it('makes over-cap documents read-only and refuses saves that would cross the cap', async () => {
      await repo.create({ path: '/projects/p/huge.md', type: 'log', body: 'x'.repeat(CAP + 100) });
      const loaded = await call('GET', '/api/documents/doc?path=/projects/p/huge.md');
      expect(loaded.body.editable).toBe(false);
      expect(loaded.body.okf).toBeNull();

      const blocked = await call('PUT', '/api/documents/doc', {
        path: '/projects/p/huge.md', content: emitOkfDocument({ type: 'log', body: 'short\n' }), expectedVersion: 1,
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.reason).toBe('over_cap');
      expect(blocked.body.error).toMatch(/read-only/);

      await repo.create({ path: '/projects/p/small.md', type: 'note', body: 'small\n' });
      const grown = await call('PUT', '/api/documents/doc', {
        path: '/projects/p/small.md', content: emitOkfDocument({ type: 'note', body: 'y'.repeat(CAP) }), expectedVersion: 1,
      });
      expect(grown.status).toBe(413);
      expect((await repo.read('/projects/p/small.md'))!.body).toBe('small\n');
    });

    it('rejects invalid OKF and a missing expectedVersion', async () => {
      await repo.create({ path: '/projects/p/brief.md', type: 'brief', body: 'x\n' });
      expect((await call('PUT', '/api/documents/doc', { path: '/projects/p/brief.md', content: 'no frontmatter', expectedVersion: 1 })).status).toBe(400);
      expect((await call('PUT', '/api/documents/doc', { path: '/projects/p/brief.md', content: '---\ntitle: x\n---\n', expectedVersion: 1 })).status).toBe(400);
      expect((await call('PUT', '/api/documents/doc', { path: '/projects/p/brief.md', content: emitOkfDocument({ type: 'b', body: '' }) })).status).toBe(400);
    });
  });

  describe('create', () => {
    it('creates at a new path with provenance, log entry and audit', async () => {
      const created = await call('POST', '/api/documents/doc', {
        path: '/projects/new/notes.md',
        content: emitOkfDocument({ type: 'reference', frontmatter: { title: 'Notes' }, body: '# Notes\n' }),
      });
      expect(created.status).toBe(201);
      expect(created.body.document.version).toBe(1);
      const row = (await repo.read('/projects/new/notes.md'))!;
      expect(row.type).toBe('reference');
      expect(row.frontmatter[PRINCIPAL_EDIT_STAMP_KEY]).toBeDefined();
      expect(await logBody('/projects/new/')).toMatch(/console-create \| principal created notes\.md/);
      expect(auditActions()).toEqual(['create']);
    });

    it('rejects an existing live path', async () => {
      await repo.create({ path: '/projects/new/notes.md', type: 'reference', body: 'mine\n' });
      const res = await call('POST', '/api/documents/doc', {
        path: '/projects/new/notes.md', content: emitOkfDocument({ type: 'reference', body: 'theirs\n' }),
      });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('exists');
      expect((await repo.read('/projects/new/notes.md'))!.body).toBe('mine\n');
    });

    it.each(['/projects/new/index.md', '/projects/new/log.md'])('rejects the reserved leaf %s', async (path) => {
      const res = await call('POST', '/api/documents/doc', { path, content: emitOkfDocument({ type: 'log', body: '' }) });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe('reserved');
      expect(await repo.read(path)).toBeNull();
    });

    it('rejects a non-.md or relative path', async () => {
      const content = emitOkfDocument({ type: 'n', body: '' });
      expect((await call('POST', '/api/documents/doc', { path: 'projects/a.md', content })).status).toBe(400);
      expect((await call('POST', '/api/documents/doc', { path: '/projects/a.txt', content })).status).toBe(400);
    });
  });

  describe('archive and restore', () => {
    it('archives without deleting the row', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'keep me\n' });
      const res = await call('POST', '/api/documents/archive', { path: '/projects/a/doc.md', expectedVersion: 1 });

      expect(res.status).toBe(200);
      expect(res.body.document.archivedAt).not.toBeNull();
      expect(await repo.read('/projects/a/doc.md')).toBeNull();
      const { rows } = await store.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM working_documents WHERE path = '/projects/a/doc.md'`);
      expect(rows[0]!.n).toBe('1');
      expect(await logBody('/projects/a/')).toMatch(/console-archive \| principal archived doc\.md/);
      expect(auditActions()).toEqual(['archive']);
    });

    it('refuses to archive a version you are not looking at', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'x\n' });
      const res = await call('POST', '/api/documents/archive', { path: '/projects/a/doc.md', expectedVersion: 7 });
      expect(res.status).toBe(409);
      expect(await repo.read('/projects/a/doc.md')).not.toBeNull();
    });

    it('does not archive an agent write that lands after the version check (#1822 review)', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'v1\n' });
      await repo.update('/projects/a/doc.md', { body: 'agent v2\n', expectedVersion: 1 });
      expect(await repo.softDeleteAtVersion('/projects/a/doc.md', 1)).toMatchObject({ ok: false, conflict: true });
      expect((await repo.read('/projects/a/doc.md'))!.body).toBe('agent v2\n');
      expect(await repo.softDeleteAtVersion('/projects/missing.md', 1)).toBeNull();
    });

    it('restores an archived document to live', async () => {
      await repo.create({ path: '/projects/a/target.md', type: 'reference', body: 't\n' });
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'See [[target]].\n' });
      const archived = (await repo.softDelete('/projects/a/doc.md'))!;

      const res = await call('POST', '/api/documents/restore', { id: archived.id });

      expect(res.status).toBe(200);
      expect(res.body.document.archivedAt).toBeNull();
      expect(res.body.document.version).toBe(2);
      expect((await repo.read('/projects/a/doc.md'))!.id).toBe(archived.id);
      expect((await repo.getBacklinks('/projects/a/target.md')).map(l => l.sourcePath)).toEqual(['/projects/a/doc.md']);
      expect(await logBody('/projects/a/')).toMatch(/console-restore \| principal restored doc\.md/);
      expect(auditActions()).toEqual(['restore']);
    });

    it('rejects a restore when the path has been reused', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'old\n' });
      const archived = (await repo.softDelete('/projects/a/doc.md'))!;
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'new\n' });

      const res = await call('POST', '/api/documents/restore', { id: archived.id });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('path_in_use');
      expect((await repo.read('/projects/a/doc.md'))!.body).toBe('new\n');
      expect(auditActions()).toEqual([]);
    });

    it('rejects restoring a live row', async () => {
      const live = await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'x\n' });
      expect((await call('POST', '/api/documents/restore', { id: live.id })).status).toBe(400);
    });
  });

  describe('write-ahead audit (#2235 review)', () => {
    it('records the request before writing, then the completion', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'x\n' });
      let bodyAtRequest: string | undefined;
      publish.mockImplementation(async (_layer, event) => {
        if (event.type === 'document.console_action' && 'stage' in event.payload && event.payload.stage === 'requested') {
          bodyAtRequest = (await repo.read('/projects/a/doc.md'))!.body;
        }
      });
      const res = await call('PUT', '/api/documents/doc', {
        path: '/projects/a/doc.md', content: emitOkfDocument({ type: 'brief', body: 'y\n' }), expectedVersion: 1,
      });
      expect(res.status).toBe(200);
      expect(bodyAtRequest).toBe('x\n');
      expect(auditTrail()).toEqual(['requested:update', 'completed:update']);
    });

    it('refuses the change when the request cannot be audited — nothing is written', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'x\n' });
      publish.mockRejectedValueOnce(new Error('audit_log unavailable'));
      const res = await call('PUT', '/api/documents/doc', {
        path: '/projects/a/doc.md', content: emitOkfDocument({ type: 'brief', body: 'y\n' }), expectedVersion: 1,
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Nothing was changed/);
      const row = (await repo.read('/projects/a/doc.md'))!;
      expect([row.body, row.version]).toEqual(['x\n', 1]);
      expect(await repo.read('/projects/a/log.md')).toBeNull();
    });

    it('leaves only a request on the trail when the write loses a conflict', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'x\n' });
      await repo.update('/projects/a/doc.md', { body: 'agent\n', expectedVersion: 1 });
      const res = await call('PUT', '/api/documents/doc', {
        path: '/projects/a/doc.md', content: emitOkfDocument({ type: 'brief', body: 'y\n' }), expectedVersion: 1,
      });
      expect(res.status).toBe(409);
      expect(auditTrail()).toEqual(['requested:update']);
    });

    it('returns success with a warning when the completion event fails after the change', async () => {
      await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'x\n' });
      publish.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('audit_log unavailable'));
      const res = await call('PUT', '/api/documents/doc', {
        path: '/projects/a/doc.md', content: emitOkfDocument({ type: 'brief', body: 'y\n' }), expectedVersion: 1,
      });
      expect(res.status).toBe(200);
      expect((res.body as unknown as { warnings: string[] }).warnings).toEqual([expect.stringMatching(/completion audit entry failed/)]);
      expect((await repo.read('/projects/a/doc.md'))!.body).toBe('y\n');
    });
  });

  it('warns, rather than failing, when the log.md entry cannot be written (#2235 review)', async () => {
    await repo.create({ path: '/projects/a/doc.md', type: 'brief', body: 'x\n' });
    const failingLogRepo = Object.create(repo) as WorkingDocsRepo;
    failingLogRepo.create = async (params) => {
      if (params.path.endsWith('/log.md')) throw new Error('log write failed');
      return repo.create(params);
    };
    const logApp = Fastify();
    await logApp.register(cookie);
    await logApp.register(documentsRoutes, {
      workingDocs: failingLogRepo, logger: createSilentLogger(), webAppBootstrapSecret: SECRET,
      sessions: new Map(), scratchTtlDays: 7, editMaxBytes: CAP, bus: { publish },
    });
    const res = await logApp.inject({
      method: 'PUT', url: '/api/documents/doc', headers: AUTH,
      payload: { path: '/projects/a/doc.md', content: emitOkfDocument({ type: 'brief', body: 'y\n' }), expectedVersion: 1 },
    });
    await logApp.close();
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.payload) as { warnings: string[] }).warnings).toEqual([expect.stringMatching(/entry in log\.md could not be written/)]);
    expect((await repo.read('/projects/a/doc.md'))!.body).toBe('y\n');
    expect(auditActions()).toEqual(['update']);
  });

  it('does not log a log.md edit into itself', async () => {
    await repo.create({ path: '/projects/a/log.md', type: 'log', body: '## [t] x | y\n' });
    const res = await call('PUT', '/api/documents/doc', {
      path: '/projects/a/log.md', content: emitOkfDocument({ type: 'log', body: '## [t] x | corrected\n' }), expectedVersion: 1,
    });
    expect(res.status).toBe(200);
    expect((await repo.read('/projects/a/log.md'))!.body).toBe('## [t] x | corrected\n');
    expect(auditActions()).toEqual(['update']);
  });
});
