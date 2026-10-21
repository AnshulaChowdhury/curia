// Integration tests for the console Documents read API (#1821) — real Postgres, private
// schema (tests/helpers/isolated-working-docs.ts) so parallel suites can't disturb it.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentsRoutes } from '../../src/channels/http/routes/documents.js';
import { WorkingDocsRepo, type WorkingDocRow } from '../../src/db/working-docs-repo.js';
import { parseOkfDocument } from '../../src/memory/okf.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const SECRET = 'documents-test-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET };

const ACTIVITY_LOG = Array.from(
  { length: 400 },
  (_, i) => `## [2026-09-${String(i % 28 + 1).padStart(2, '0')}] post | update ${i}\n\n${'Posted to the feed. '.repeat(25)}\n`,
).join('\n');

interface ListedDoc { id: string; path: string; type: string; title: string | null; archivedAt: string | null; scratchExpiry: { expiresAt: string | null; exempt: boolean } | null }

describeIf('console Documents routes (integration)', () => {
  let store: IsolatedWorkingDocsStore;
  let repo: WorkingDocsRepo;
  let app: FastifyInstance;
  let archivedRow: WorkingDocRow;
  const registered: string[] = [];

  beforeAll(async () => {
    store = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    repo = new WorkingDocsRepo(store.pool, createSilentLogger());

    await repo.create({ path: '/projects/social-media/activity-log.md', type: 'log', frontmatter: { title: 'Activity' }, body: ACTIVITY_LOG });
    await repo.create({ path: '/projects/social-media/brief.md', type: 'brief', frontmatter: { title: 'Social brief' }, body: 'See [the log](activity-log.md) and [[plan]].\n' });
    await repo.create({ path: '/projects/social-media/plan.md', type: 'plan', body: 'Plan for LISBON trip.\n' });
    await repo.create({ path: '/projects/social-mediax/other.md', type: 'brief', body: 'Sibling prefix, not a child.\n' });
    await repo.create({ path: '/projects/3467d2d0-1695-4d90-9789-3319ba5a2c65/checklist.md', type: 'checklist', frontmatter: { title: 'Medical prep' }, body: '- [ ] fast from midnight\n' });
    await repo.create({ path: '/scratch/conv-1/draft.md', type: 'shadow-draft', body: 'draft lisbon\n' });
    await repo.create({ path: '/scratch/conv-1/pinned.md', type: 'shadow-draft', frontmatter: { ttl_days: 0 }, body: 'keep\n' });
    // 60 matching lines so search must paginate past 50.
    await repo.create({ path: '/projects/notes/many.md', type: 'reference', body: Array.from({ length: 60 }, (_, i) => `Needle line ${i}`).join('\n') });
    await repo.create({ path: '/projects/old/gone.md', type: 'analysis', body: 'Old analysis, needle.\n' });
    archivedRow = (await repo.softDelete('/projects/old/gone.md'))!;

    app = Fastify();
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.push(`${method} ${route.url}`);
    });
    await app.register(cookie);
    await app.register(documentsRoutes, {
      workingDocs: repo,
      logger: createSilentLogger(),
      webAppBootstrapSecret: SECRET,
      sessions: new Map(),
      scratchTtlDays: 7,
      editMaxBytes: 64 * 1024,
      bus: { publish: async () => {} },
    });
  });

  afterAll(async () => {
    await app?.close();
    await store?.drop();
  });

  async function get<T>(url: string): Promise<{ status: number; body: T; headers: Record<string, unknown>; raw: string }> {
    const res = await app.inject({ method: 'GET', url, headers: AUTH });
    const raw = res.payload;
    const isJson = String(res.headers['content-type'] ?? '').includes('application/json');
    return { status: res.statusCode, body: (isJson ? JSON.parse(raw) : raw) as T, headers: res.headers, raw };
  }

  describe('auth and read-only surface', () => {
    const urls = [
      '/api/documents',
      '/api/documents/doc?path=/projects/social-media/brief.md',
      '/api/documents/search?q=needle',
      '/api/documents/download?path=/projects/social-media/brief.md',
    ];

    it.each(urls)('rejects an unauthenticated %s', async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      const wrong = await app.inject({ method: 'GET', url, headers: { 'x-web-bootstrap-secret': 'nope' } });
      expect(wrong.statusCode).toBe(401);
    });

    it('writes only through the four mutation routes (#1822)', () => {
      const writes = registered.filter(r => !r.startsWith('GET ') && !r.startsWith('HEAD ')).sort();
      expect(writes).toEqual([
        'POST /api/documents/archive',
        'POST /api/documents/doc',
        'POST /api/documents/restore',
        'PUT /api/documents/doc',
      ]);
    });

    it('leaves the store unchanged after exercising every route', async () => {
      const snapshot = async () => (await store.pool.query(
        'SELECT id, path, version, updated_at, archived_at FROM working_documents ORDER BY id',
      )).rows;
      const before = await snapshot();
      for (const url of urls) expect((await get(url)).status).toBe(200);
      await get(`/api/documents/doc?id=${archivedRow.id}`);
      await get('/api/documents?status=all');
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('GET /api/documents', () => {
    it('lists live documents only by default, without bodies', async () => {
      const { body } = await get<{ documents: Array<ListedDoc & { body?: string }> }>('/api/documents');
      const paths = body.documents.map(d => d.path);
      expect(paths).toContain('/projects/social-media/brief.md');
      expect(paths).not.toContain('/projects/old/gone.md');
      expect(body.documents.every(d => d.body === undefined)).toBe(true);
    });

    it('limits a prefix to exactly the documents under it', async () => {
      const { body } = await get<{ documents: ListedDoc[] }>('/api/documents?prefix=/projects/social-media/');
      expect(body.documents.map(d => d.path).sort()).toEqual([
        '/projects/social-media/activity-log.md',
        '/projects/social-media/brief.md',
        '/projects/social-media/plan.md',
      ]);
    });

    it('filters by type and reports every type for the filter control', async () => {
      const { body } = await get<{ documents: ListedDoc[]; types: Array<{ name: string; count: number }> }>(
        '/api/documents?type=brief',
      );
      expect(body.documents.map(d => d.path).sort()).toEqual([
        '/projects/social-media/brief.md',
        '/projects/social-mediax/other.md',
      ]);
      expect(body.types.map(t => t.name)).toEqual(['brief', 'checklist', 'log', 'plan', 'reference', 'shadow-draft']);
    });

    it('shows archived rows behind the status filter', async () => {
      const archived = await get<{ documents: ListedDoc[] }>('/api/documents?status=archived');
      expect(archived.body.documents.map(d => d.path)).toEqual(['/projects/old/gone.md']);
      expect(archived.body.documents[0]!.archivedAt).not.toBeNull();
      const all = await get<{ documents: ListedDoc[] }>('/api/documents?status=all');
      expect(all.body.documents).toHaveLength(9);
    });

    it('derives scratch expiry and the ttl_days: 0 exemption', async () => {
      const { body } = await get<{ documents: ListedDoc[] }>('/api/documents?prefix=/scratch/');
      const draft = body.documents.find(d => d.path === '/scratch/conv-1/draft.md')!;
      const pinned = body.documents.find(d => d.path === '/scratch/conv-1/pinned.md')!;
      expect(draft.scratchExpiry?.expiresAt).toMatch(/^\d{4}-/);
      expect(pinned.scratchExpiry).toEqual({ expiresAt: null, exempt: true, ttlDays: null });
      const project = (await get<{ documents: ListedDoc[] }>('/api/documents?prefix=/projects/notes/')).body.documents[0]!;
      expect(project.scratchExpiry).toBeNull();
    });

    it('rejects a bad status or relative prefix', async () => {
      expect((await get('/api/documents?status=deleted')).status).toBe(400);
      expect((await get('/api/documents?prefix=projects')).status).toBe(400);
    });
  });

  describe('GET /api/documents/doc', () => {
    it('returns body, frontmatter, the full metadata set and rendered HTML', async () => {
      const { status, body } = await get<{
        document: Record<string, unknown>;
        htmlChunks: string[];
        backlinks: unknown[];
      }>('/api/documents/doc?path=/projects/social-media/brief.md');
      expect(status).toBe(200);
      for (const key of ['version', 'byteSize', 'taskId', 'conversationId', 'agentId', 'createdAt', 'updatedAt', 'archivedAt']) {
        expect(body.document).toHaveProperty(key);
      }
      expect(body.document.frontmatter).toEqual({ title: 'Social brief' });
      expect(body.document.body).toContain('[[plan]]');
      expect(body.htmlChunks.join('')).toContain('<a href="activity-log.md">');
    });

    it('chunks the 211 kB-class activity log for progressive rendering', async () => {
      const { body } = await get<{ htmlChunks: string[]; document: { byteSize: number } }>(
        '/api/documents/doc?path=/projects/social-media/activity-log.md',
      );
      expect(body.document.byteSize).toBeGreaterThan(200_000);
      expect(body.htmlChunks.length).toBeGreaterThan(8);
      expect(body.htmlChunks[0]!.length).toBeLessThan(40_000);
    });

    it('lists backlinks when they exist and an empty list otherwise', async () => {
      const linked = await get<{ backlinks: Array<{ sourcePath: string; linkKind: string }> }>(
        '/api/documents/doc?path=/projects/social-media/plan.md',
      );
      expect(linked.body.backlinks).toEqual([{ sourcePath: '/projects/social-media/brief.md', linkKind: 'wikilink' }]);
      const lonely = await get<{ backlinks: unknown[] }>('/api/documents/doc?path=/scratch/conv-1/draft.md');
      expect(lonely.body.backlinks).toEqual([]);
    });

    it('opens an archived row by id, and not by path', async () => {
      const byId = await get<{ document: { path: string; archivedAt: string | null } }>(`/api/documents/doc?id=${archivedRow.id}`);
      expect(byId.status).toBe(200);
      expect(byId.body.document.archivedAt).not.toBeNull();
      expect((await get('/api/documents/doc?path=/projects/old/gone.md')).status).toBe(404);
    });

    it('validates the target', async () => {
      expect((await get('/api/documents/doc')).status).toBe(400);
      expect((await get('/api/documents/doc?id=not-a-uuid')).status).toBe(400);
      expect((await get('/api/documents/doc?path=/nope.md')).status).toBe(404);
    });
  });

  describe('GET /api/documents/search', () => {
    it('is case-insensitive over bodies and paths, with context', async () => {
      const { body } = await get<{ matches: Array<{ path: string; kind: string; context?: string }> }>(
        '/api/documents/search?q=LiSbOn',
      );
      expect(body.matches.map(m => m.path).sort()).toEqual(['/projects/social-media/plan.md', '/scratch/conv-1/draft.md']);
      expect(body.matches.find(m => m.path === '/projects/social-media/plan.md')?.context).toBe('Plan for LISBON trip.');

      const byPath = await get<{ matches: Array<{ path: string; kind: string }> }>('/api/documents/search?q=MEDIAX');
      expect(byPath.body.matches).toEqual([expect.objectContaining({ path: '/projects/social-mediax/other.md', kind: 'path' })]);
    });

    it('paginates beyond 50 matches', async () => {
      const first = await get<{ total: number; matches: unknown[] }>('/api/documents/search?q=needle%20line&limit=50');
      expect(first.body.total).toBe(60);
      expect(first.body.matches).toHaveLength(50);
      const second = await get<{ matches: Array<{ lineNumber: number }> }>('/api/documents/search?q=needle%20line&limit=50&offset=50');
      expect(second.body.matches.map(m => m.lineNumber)).toEqual(Array.from({ length: 10 }, (_, i) => 51 + i));
    });

    it('searches archived rows only when asked', async () => {
      const live = await get<{ matches: Array<{ path: string }> }>('/api/documents/search?q=old%20analysis');
      expect(live.body.matches).toEqual([]);
      const all = await get<{ matches: Array<{ path: string; archived: boolean }> }>('/api/documents/search?q=old%20analysis&status=all');
      expect(all.body.matches).toEqual([expect.objectContaining({ path: '/projects/old/gone.md', archived: true })]);
    });

    it('scopes to a prefix and validates input', async () => {
      const scoped = await get<{ matches: Array<{ path: string }> }>('/api/documents/search?q=lisbon&prefix=/scratch/');
      expect(scoped.body.matches.map(m => m.path)).toEqual(['/scratch/conv-1/draft.md']);
      expect((await get('/api/documents/search?q=')).status).toBe(400);
      expect((await get('/api/documents/search?q=x&limit=0')).status).toBe(400);
    });
  });

  describe('GET /api/documents/download', () => {
    it('returns OKF that parseOkfDocument accepts, as an attachment', async () => {
      const res = await get<string>('/api/documents/download?path=/projects/social-media/brief.md');
      expect(res.status).toBe(200);
      expect(String(res.headers['content-type'])).toContain('text/markdown');
      expect(String(res.headers['content-disposition'])).toMatch(/filename="brief\.v1\.[0-9a-f]{8}\.md"/);
      const parsed = parseOkfDocument(res.raw);
      expect(parsed.type).toBe('brief');
      expect(parsed.frontmatter.title).toBe('Social brief');
      expect(parsed.body).toBe('See [the log](activity-log.md) and [[plan]].\n');
    });

    it('downloads an archived row by id', async () => {
      const res = await get<string>(`/api/documents/download?id=${archivedRow.id}`);
      expect(res.status).toBe(200);
      expect(parseOkfDocument(res.raw).type).toBe('analysis');
    });
  });
});
