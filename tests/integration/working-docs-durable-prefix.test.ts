// Integration: project archival must not touch durable /meetings/ documents (#2322).
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';

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
});
