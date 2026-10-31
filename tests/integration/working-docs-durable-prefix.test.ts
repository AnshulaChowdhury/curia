// Integration: project archival must not touch durable /meetings/ (#2322) or /shared/ (#2338) documents.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import type { ToolContext } from '../../src/skills/types.js';
import { DocWriteHandler } from '../../skills/documents/tools/doc-write/handler.js';
import { createPinnedContextReader, renderPinnedContextBlock } from '../../src/agents/pinned-context.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('working docs durable prefix (#2322)', () => {
  let store: IsolatedWorkingDocsStore;
  let repo: WorkingDocsRepo;

  beforeAll(async () => {
    store = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    repo = new WorkingDocsRepo(store.pool, createSilentLogger());
  });

  afterAll(async () => {
    await store?.drop();
  });

  it('archiveProjectWorkspaceDocs leaves a task-stamped /meetings/ doc live', async () => {
    const taskId = randomUUID();
    await repo.create({
      path: '/meetings/agendas/a.md',
      type: 'meeting-agenda',
      body: 'agenda',
      taskId,
    });
    await repo.create({
      path: '/projects/p/b.md',
      type: 'note',
      body: 'project',
      taskId,
    });

    const archived = await repo.archiveProjectWorkspaceDocs(taskId);

    expect(archived).toBe(1);
    expect(await repo.read('/meetings/agendas/a.md')).not.toBeNull();
    expect(await repo.read('/projects/p/b.md')).toBeNull();
  });

  it('archiveProjectWorkspaceDocs leaves a task-stamped /shared/ doc live (#2338)', async () => {
    // A legacy or hand-made row could carry a task_id; doc-write never stamps one here.
    const taskId = randomUUID();
    await repo.create({ path: '/shared/inbox/rules.md', type: 'agent-settings', body: '## Rule', taskId });
    await repo.create({ path: '/projects/q/c.md', type: 'note', body: 'project', taskId });

    expect(await repo.archiveProjectWorkspaceDocs(taskId)).toBe(1);
    expect(await repo.read('/shared/inbox/rules.md')).not.toBeNull();
    expect(await repo.read('/projects/q/c.md')).toBeNull();
  });

  it('a /shared/ doc-write during a task-bound wake survives that project\'s archival (#2338)', async () => {
    const rootTaskId = randomUUID();
    const registry = new AgentRegistry();
    registry.register('ceo-inbox', {
      role: 'specialist',
      description: 'inbox',
      pinnedDocPaths: ['/shared/wake/rules.md'],
    });
    const ctx = {
      input: { path: '/shared/wake/rules.md', mode: 'create', type: 'agent-settings', body: '## Rule' },
      log: createSilentLogger(),
      timezone: 'UTC',
      agentId: 'ceo-inbox',
      agentRegistry: registry,
      workingDocs: repo,
      taskMetadata: { boundTask: { taskId: rootTaskId } },
      taskRepo: { resolveProjectRootTaskId: async () => rootTaskId },
    } as unknown as ToolContext;

    const result = await new DocWriteHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect((await repo.read('/shared/wake/rules.md'))?.taskId).toBeNull();

    await repo.archiveProjectWorkspaceDocs(rootTaskId);
    expect(await repo.read('/shared/wake/rules.md')).not.toBeNull();
  });

  it('an archived /shared/ doc is not recreated by doc-write and is not shown as not yet created', async () => {
    const path = '/shared/archived/rules.md';
    const registry = new AgentRegistry();
    registry.register('ceo-inbox', { role: 'specialist', description: 'inbox', pinnedDocPaths: [path] });
    const ctx = (input: Record<string, unknown>) => ({
      input,
      log: createSilentLogger(),
      timezone: 'UTC',
      agentId: 'ceo-inbox',
      agentRegistry: registry,
      workingDocs: repo,
    } as unknown as ToolContext);

    expect((await new DocWriteHandler().execute(ctx({ path, mode: 'create', type: 'agent-settings', body: '## Original' }))).success)
      .toBe(true);
    const original = (await repo.read(path))!;
    expect((await repo.softDeleteAtVersion(path, original.version))?.ok).toBe(true);

    const reader = createPinnedContextReader({ workingDocsRepo: repo, logger: createSilentLogger() });
    const block = await renderPinnedContextBlock([{ kind: 'doc', path }], reader, {
      agentId: 'ceo-inbox',
      logger: createSilentLogger(),
    });
    expect(block).toContain('_Archived by the principal._');
    expect(block).not.toContain('Not yet created');

    const recreate = await new DocWriteHandler().execute(ctx({ path, mode: 'create', type: 'agent-settings', body: '## New' }));
    expect(recreate.success).toBe(false);
    expect(await repo.read(path)).toBeNull();

    // The principal can still restore the original.
    expect((await repo.restore(original.id)).ok).toBe(true);
    expect((await repo.read(path))?.body).toBe('## Original');
  });
});
