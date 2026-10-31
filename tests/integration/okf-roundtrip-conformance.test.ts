// OKF round-trip conformance (#1824).
//
// Spec 20 §2's central claim is that format is decoupled from storage: agents read and
// write OKF, the bytes live in Postgres. This test is what enforces it. It seeds a store
// with the real data shape plus the inputs most likely to break serialization, exports
// it through the console export route, imports the bundle into a second, empty store
// through the import route, and requires the content to come back identical.
//
// Content, not rows: version, timestamps, task/conversation/agent ids and archived_at are
// store bookkeeping that an import legitimately creates fresh.
//
// Both stores are private schemas (tests/helpers/isolated-working-docs.ts), so the test
// holds no shared fixture state and is unaffected by suites that clear working_documents.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentsRoutes } from '../../src/channels/http/routes/documents.js';
import { WorkingDocsRepo, type CreateWorkingDocParams } from '../../src/db/working-docs-repo.js';
import { emitOkfDocument, parseOkfDocument } from '../../src/memory/okf.js';
import type { ImportPlan } from '../../src/memory/okf-bundle-import.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const SECRET = 'okf-roundtrip-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET };

const ACTIVITY_LOG = Array.from(
  { length: 1100 },
  (_, i) => `## [2026-09-${String(i % 28 + 1).padStart(2, '0')}T08:00:00Z] post | LinkedIn ${i}\n\nPosted — engagement ${i * 7}. See [[brief]].\n`,
).join('\n');

/** The seed: production's shape plus serialization hazards. Paths are unique. */
const SEED: CreateWorkingDocParams[] = [
  // Real shape: readable slugs, an opaque task-UUID directory, /scratch conversations.
  {
    path: '/projects/social-media/activity-log.md',
    type: 'log',
    frontmatter: { title: 'Social media activity log', tags: ['social', 'linkedin'], timestamp: '2026-09-18T12:00:00Z' },
    body: ACTIVITY_LOG,
  },
  {
    path: '/projects/social-media/brief.md',
    type: 'brief',
    // Keys deliberately out of order; jsonb normalizes them on both sides.
    frontmatter: { zeta: 1, title: 'Social brief', alpha: { nested: { deep: [1, 'two', { three: 3 }] } }, tags: [] },
    body: '# Brief\n\nSee the [activity log](activity-log.md), [[plan]], [abs](/scratch/conv-1/draft.md) and [ext](https://example.com).\n',
  },
  {
    path: '/projects/social-media/plan.md',
    type: 'plan',
    frontmatter: { title: 'Plan', priority: 2, ratio: 1.5, negative: -3, done: false, owner: null, empty: {} },
    body: '1. Post weekly\n2. Review [[../evening-routine-check/analysis]]\n',
  },
  {
    path: '/projects/3467d2d0-1695-4d90-9789-3319ba5a2c65/checklist.md',
    type: 'checklist',
    frontmatter: { title: 'Medical prep' },
    body: '- [x] book appointment\n- [ ] fast from midnight\n',
  },
  {
    path: '/projects/evening-routine-check/analysis.md',
    type: 'analysis',
    // Strings YAML would happily reinterpret if they were written unquoted.
    frontmatter: {
      title: 'yes', also: 'null', octal: '0123', sci: '1e3', date: '2026-10-21', colon: 'a: b', hash: '# not a comment',
      multiline: 'line one\n---\nline three', trailing: 'space ', quote: '"quoted"',
    },
    body: 'Analysis.',
  },
  {
    path: '/projects/evening-routine-check/queue.md',
    type: 'queue',
    frontmatter: { 'ключ': 'значение', '日本語': '値', emoji: '🗂️' },
    body: 'Unicode: café, naïve, 中文, עברית, emoji 👩🏽‍💻, combining é.\n',
  },
  {
    path: '/projects/reference/fences.md',
    type: 'reference',
    // Fenced code holding a frontmatter delimiter and wikilink syntax. Note the fence
    // contents still feed the link index (extractLinks does not skip code), so both
    // stores must agree on that too.
    body: '# Fences\n\n```yaml\n---\ntype: not-frontmatter\n---\n```\n\n~~~\n[[inside-a-fence]]\n~~~\n\nAfter.\n',
  },
  {
    path: '/projects/reference/looks-like-frontmatter.md',
    type: 'reference',
    frontmatter: { title: 'Body that starts like a document' },
    body: '---\ntype: fake\ntitle: Not the real frontmatter\n---\n\nThe real body follows a fake header.\n',
  },
  { path: '/projects/reference/no-trailing-newline.md', type: 'reference', body: 'last line has no newline' },
  { path: '/projects/reference/empty.md', type: 'project', body: '' },
  { path: '/projects/reference/crlf.md', type: 'reference', body: 'windows\r\nline endings\r\n' },
  { path: '/projects/reference/leading-blank.md', type: 'reference', body: '\n\nstarts with blank lines\n' },
  { path: '/projects/social-media/log.md', type: 'log', body: '## [2026-09-18T00:00:00Z] create | brief.md\n' },
  // Scratch: default TTL, an explicit TTL, and a pinned document (ttl_days: 0).
  { path: '/scratch/conv-1/draft.md', type: 'shadow-draft', body: 'Draft reply.\n' },
  { path: '/scratch/conv-1/short-lived.md', type: 'shadow-draft', frontmatter: { ttl_days: 2 }, body: 'Gone soon.\n' },
  { path: '/scratch/conv-2/pinned.md', type: 'reference', frontmatter: { ttl_days: 0, title: 'Pinned' }, body: 'Keep [[../conv-1/draft]].\n' },
];

interface LinkRow { source_path: string; target_path: string; link_kind: string }

describeIf('OKF export → import round trip (integration, #1824)', () => {
  let source: IsolatedWorkingDocsStore;
  let target: IsolatedWorkingDocsStore;
  let sourceRepo: WorkingDocsRepo;
  let targetRepo: WorkingDocsRepo;
  let sourceApp: FastifyInstance;
  let targetApp: FastifyInstance;
  let plan: ImportPlan;
  let applied: { created: string[]; updated: string[]; conflicts: unknown[] };

  async function appFor(repo: WorkingDocsRepo): Promise<FastifyInstance> {
    const app = Fastify();
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
    return app;
  }

  async function links(store: IsolatedWorkingDocsStore): Promise<LinkRow[]> {
    const { rows } = await store.pool.query<LinkRow>(
      'SELECT source_path, target_path, link_kind FROM working_document_links ORDER BY source_path, target_path, link_kind',
    );
    return rows;
  }

  beforeAll(async () => {
    source = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    target = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    sourceRepo = new WorkingDocsRepo(source.pool, createSilentLogger());
    targetRepo = new WorkingDocsRepo(target.pool, createSilentLogger());
    for (const doc of SEED) await sourceRepo.create(doc);
    // An archived row is store history, not part of a live export.
    await sourceRepo.create({ path: '/projects/old/retired.md', type: 'analysis', body: 'Retired.\n' });
    await sourceRepo.softDelete('/projects/old/retired.md');

    sourceApp = await appFor(sourceRepo);
    targetApp = await appFor(targetRepo);

    const exported = await sourceApp.inject({ method: 'GET', url: '/api/documents/export', headers: AUTH });
    expect(exported.statusCode).toBe(200);
    const zip = exported.rawPayload;

    const upload = (query: string) => targetApp.inject({
      method: 'POST', url: `/api/documents/import?${query}`, headers: { ...AUTH, 'content-type': 'application/zip' }, payload: zip,
    });
    const preview = await upload('mode=preview&format=zip');
    expect(preview.statusCode).toBe(200);
    plan = (JSON.parse(preview.payload) as { plan: ImportPlan }).plan;
    const apply = await upload(`mode=apply&format=zip&planToken=${plan.token}`);
    expect(apply.statusCode).toBe(200);
    applied = (JSON.parse(apply.payload) as { result: typeof applied }).result;
    // Seeds, exports and imports a 211 kB-class store; generous for a loaded runner.
  }, 30_000);

  afterAll(async () => {
    await sourceApp?.close();
    await targetApp?.close();
    await source?.drop();
    await target?.drop();
  });

  it('imports every live document into the empty store, skipping nothing', () => {
    expect(plan.skipped).toEqual([]);
    expect(plan.counts).toEqual({ create: SEED.length, update: 0, unchanged: 0, conflict: 0, skipped: 0 });
    expect(applied.created.sort()).toEqual(SEED.map(d => d.path).sort());
    expect(applied.conflicts).toEqual([]);
  });

  it.each(SEED.map(d => [d.path]))('%s comes back with identical path, type, frontmatter and body', async (path) => {
    const original = (await sourceRepo.read(path))!;
    const copy = await targetRepo.read(path);
    expect(copy).not.toBeNull();
    expect(copy!.path).toBe(original.path);
    expect(copy!.type).toBe(original.type);
    expect(copy!.frontmatter).toEqual(original.frontmatter);
    // Same key order too — both sides are jsonb, so this pins the normalization behaviour.
    expect(JSON.stringify(copy!.frontmatter)).toBe(JSON.stringify(original.frontmatter));
    // Byte-for-byte, with the lengths in the message so a whitespace drift is legible.
    expect({ bytes: Buffer.byteLength(copy!.body), body: copy!.body })
      .toEqual({ bytes: Buffer.byteLength(original.body), body: original.body });
    expect(copy!.byteSize).toBe(original.byteSize);
  });

  it('keeps ttl_days: 0 as the number zero', async () => {
    expect((await targetRepo.read('/scratch/conv-2/pinned.md'))!.frontmatter.ttl_days).toBe(0);
  });

  it('extracts the same markdown and wikilink rows in both stores', async () => {
    const sourceLinks = await links(source);
    expect(await links(target)).toEqual(sourceLinks);
    // Guard the guard: the seed really exercises both kinds.
    expect(new Set(sourceLinks.map(l => l.link_kind))).toEqual(new Set(['markdown', 'wikilink']));
  });

  it('does not carry archived history into a live export', async () => {
    expect(await targetRepo.read('/projects/old/retired.md')).toBeNull();
    expect((await targetRepo.listSummaries({ status: 'all' })).map(d => d.path)).not.toContain('/projects/old/retired.md');
  });

  it('serializes every seed through an exact emit/parse inverse', () => {
    // The direct form of the property the route-level round trip depends on: if
    // emitOkfDocument and parseOkfDocument drift apart, this fails with the document named.
    for (const doc of SEED) {
      const parsed = parseOkfDocument(emitOkfDocument({ type: doc.type, frontmatter: doc.frontmatter, body: doc.body ?? '' }));
      const { type: parsedType, ...frontmatter } = parsed.frontmatter;
      expect({ path: doc.path, type: parsedType, frontmatter, body: parsed.body })
        .toEqual({ path: doc.path, type: doc.type, frontmatter: doc.frontmatter ?? {}, body: doc.body ?? '' });
    }
  });
});
