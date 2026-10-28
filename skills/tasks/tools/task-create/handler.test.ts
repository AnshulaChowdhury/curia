import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pino from 'pino';
import { TaskCreateHandler } from './handler.js';
import {
  BLOCKED_BY_TASK_ID_ERROR,
  PARENT_TASK_ID_ERROR,
  WAITING_ON_CONTACT_ID_ERROR,
} from '../../optional-ref.js';
import { ToolRegistry } from '../../../../src/skills/registry.js';
import type { ToolContext, ToolManifest } from '../../../../src/skills/types.js';
import type { TaskRepo } from '../../../../src/db/task-repo.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';
import type { AgentRegistry } from '../../../../src/agents/agent-registry.js';

const silentLog = pino({ level: 'silent' });

// Minimal AgentRegistry stub — task-create only calls has() to validate a
// cross-agent target exists before redirecting the wake to it.
function makeRegistry(knownAgents: string[] = []): AgentRegistry {
  return {
    has: vi.fn((name: string) => knownAgents.includes(name)),
  } as unknown as AgentRegistry;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    agentId: 'coordinator',
    timezone: 'America/Toronto',
    ...overrides,
  } as unknown as ToolContext;
}

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    agentId: 'coordinator',
    intentAnchor: 'Book dentist appointment',
    title: 'Book dentist appointment',
    description: null,
    status: 'open',
    progress: { notes: [] },
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-03T10:00:00.000Z',
    updatedAt: '2026-06-03T10:00:00.000Z',
    owner: 'curia',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
    blockedByTaskId: null,
    priority: 50,
    dueAt: null,
    source: 'coordinator',
    sourceAgentId: 'coordinator',
    createdBy: 'coordinator',
    tags: [],
    originator: null,
    ...overrides,
  };
}

function makeTaskRepo(overrides: Partial<TaskRepo> = {}): TaskRepo {
  return {
    createTask: vi.fn().mockResolvedValue(makeTaskRow()),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    cancelWakeUpJobs: vi.fn(),
    ...overrides,
  } as unknown as TaskRepo;
}

describe('TaskCreateHandler', () => {
  // ── Input validation ──────────────────────────────────────────────────────

  it('returns error when title is missing', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: {}, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/title/);
  });

  it('returns error when title is blank', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: '   ' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/title/);
  });

  it('returns error when title exceeds 500 characters', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'x'.repeat(501) }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/500/);
  });

  it('returns error for invalid owner', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Do a thing', owner: 'robot' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/owner/);
  });

  it('returns error for non-ISO due_at (permissive date strings)', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Task', due_at: '2026/06/10 09:00:00' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/due_at/);
  });

  it('accepts and formats due_at with millisecond precision from DB', async () => {
    const taskRepo = makeTaskRepo({
      createTask: vi.fn().mockResolvedValue(
        makeTaskRow({ dueAt: '2026-06-10T09:00:00.123Z' }),
      ),
    });
    const ctx = makeCtx({
      input: { title: 'Task', due_at: '2026-06-10T09:00:00.000Z' },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { due_at: string | null } }).data;
    expect(data.due_at).not.toBeNull();
  });

  it('returns error for priority out of range', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Do a thing', priority: 150 }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/priority/);
  });

  it('returns error when taskRepo is not injected', async () => {
    const ctx = makeCtx({ input: { title: 'Do a thing' } });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/taskRepo/);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('creates a task and returns the task_id', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Book dentist appointment', owner: 'ceo', priority: 70 },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { task_id: string; status: string } }).data;
    expect(data.task_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(data.status).toBe('open');
  });

  it('passes title, owner, and priority to TaskRepo.createTask', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Prepare board deck', owner: 'ceo', priority: 80, tags: ['board-prep'] },
      taskRepo,
      agentId: 'ceo-inbox',
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({
      title: 'Prepare board deck',
      owner: 'ceo',
      priority: 80,
      tags: ['board-prep'],
      agentId: 'ceo-inbox',
      source: 'agent',
    });
  });

  it('derives source=coordinator when agentId is coordinator', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Follow up with Alex' },
      taskRepo,
      agentId: 'coordinator',
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].source).toBe('coordinator');
  });

  it('passes wake_at as a Date to TaskRepo.createTask', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Call Steve', wake_at: '2026-06-10T09:00:00.000Z' },
      taskRepo,
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].wakeAt).toBeInstanceOf(Date);
    expect((calls[0]![0].wakeAt as Date).toISOString()).toBe('2026-06-10T09:00:00.000Z');
  });

  it('returns displayTimezone in the result', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Task with timezone' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { displayTimezone: string } }).data;
    expect(typeof data.displayTimezone).toBe('string');
    expect(data.displayTimezone).not.toBe('');
  });

  // ── Cross-agent targeting (target_agent_id) ───────────────────────────────

  it('self-routes ownership to the calling agent when target_agent_id is omitted', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Self-owned task' },
      taskRepo,
      agentId: 'meeting-debrief',
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({
      agentId: 'meeting-debrief',
      sourceAgentId: 'meeting-debrief',
      createdBy: 'meeting-debrief',
    });
  });

  it('routes ownership and the wake to a valid cross-agent target', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: {
        title: 'Debrief: Acme sync',
        target_agent_id: 'meeting-debrief',
        wake_at: '2026-06-10T17:00:00.000Z',
      },
      taskRepo,
      agentId: 'coordinator',
      agentRegistry: makeRegistry(['coordinator', 'meeting-debrief', 'ceo-inbox']),
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    // The target owns the task (agent_id + source_agent_id) so re-wakes scheduled
    // by the target via task-update route back to it; created_by records the
    // actual creator for audit.
    expect(calls[0]![0]).toMatchObject({
      agentId: 'meeting-debrief',
      sourceAgentId: 'meeting-debrief',
      createdBy: 'coordinator',
    });
  });

  it('treats target_agent_id equal to the caller as self-routing (no registry needed)', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Self target', target_agent_id: 'meeting-debrief' },
      taskRepo,
      agentId: 'meeting-debrief',
      // No agentRegistry provided — self-targeting must not require it.
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({
      agentId: 'meeting-debrief',
      sourceAgentId: 'meeting-debrief',
      createdBy: 'meeting-debrief',
    });
  });

  it('rejects a target_agent_id that is not a registered agent', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Bad target', target_agent_id: 'ghost-agent' },
      taskRepo,
      agentId: 'coordinator',
      agentRegistry: makeRegistry(['coordinator', 'meeting-debrief']),
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/target_agent_id/);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('rejects a non-string target_agent_id', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Task', target_agent_id: 123 as unknown as string },
      taskRepo,
      agentId: 'coordinator',
      agentRegistry: makeRegistry(['coordinator']),
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/target_agent_id/);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('errors when target_agent_id is set but the agent registry is unavailable', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Task', target_agent_id: 'meeting-debrief' },
      taskRepo,
      agentId: 'coordinator',
      // agentRegistry intentionally omitted.
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/agentRegistry|registry/);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  // ── Error propagation ─────────────────────────────────────────────────────

  it('returns error when TaskRepo.createTask throws', async () => {
    const taskRepo = makeTaskRepo({
      createTask: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });
    const ctx = makeCtx({ input: { title: 'Failing task' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/DB connection lost/);
  });

  // ── Escalation seeding (#1267) ────────────────────────────────────────────

  it('forwards progress_note to createTask so the row seeds a last progress note', async () => {
    const createTask = vi.fn().mockResolvedValue(makeTaskRow());
    const taskRepo = makeTaskRepo({ createTask });
    const ctx = makeCtx({ input: { title: 'Review', progress_note: 'Stalled at 25 of 1300.' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ progressNote: 'Stalled at 25 of 1300.' }),
    );
  });

  it('seeds a past-due task with an immediate wake, a tag and a note saying to do the work (#1299)', async () => {
    const createTask = vi.fn().mockResolvedValue(makeTaskRow());
    const taskRepo = makeTaskRepo({ createTask });
    const ctx = makeCtx({
      input: { title: 'Send the Q3 numbers', due_at: '2020-01-01T09:00:00Z', progress_note: 'Milestone 2 of 3.' },
      taskRepo,
    });

    const before = Date.now();
    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const arg = createTask.mock.calls[0]![0] as { wakeAt?: Date; tags?: string[]; progressNote?: string };
    expect(arg.wakeAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(arg.tags).toContain('past-due-at-creation');
    // The caller's note comes first; the past-due note is what the woken run reads.
    expect(arg.progressNote).toMatch(/^Milestone 2 of 3\. /);
    expect(arg.progressNote).toContain('do its work now, or escalate');
  });

  it('parses escalation_json and forwards the structured block to createTask', async () => {
    const createTask = vi.fn().mockResolvedValue(makeTaskRow());
    const taskRepo = makeTaskRepo({ createTask });
    const escalation = {
      failureMode: 'agent_incomplete',
      reason: 'maxTurns',
      source: 'delegation',
      headline: 'research could not finish',
      suggestedActions: ['Re-scope it smaller.'],
    };
    const ctx = makeCtx({ input: { title: 'Review', escalation_json: JSON.stringify(escalation) }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ escalation: expect.objectContaining({ failureMode: 'agent_incomplete' }) }),
    );
  });

  it('ignores malformed escalation_json but still creates the task', async () => {
    const createTask = vi.fn().mockResolvedValue(makeTaskRow());
    const taskRepo = makeTaskRepo({ createTask });
    const ctx = makeCtx({ input: { title: 'Review', escalation_json: '{not json' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ escalation: undefined }),
    );
  });

  it('ignores a well-formed object that is not a valid escalation shape', async () => {
    const createTask = vi.fn().mockResolvedValue(makeTaskRow());
    const taskRepo = makeTaskRepo({ createTask });
    // Valid JSON, an object, but missing the required TaskEscalation fields — must not persist.
    const ctx = makeCtx({ input: { title: 'Review', escalation_json: JSON.stringify({ foo: 'bar' }) }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ escalation: undefined }),
    );
  });

  it('rejects a non-string progress_note', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Review', progress_note: 123 as unknown as string }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/progress_note/);
  });
});

// #2328: optional ids filled with "null" / "none" / blank used to hit Postgres as a
// uuid cast, and the raw error taught the model to invent a blocker id.
describe('optional reference ids (#2328)', () => {
  const placeholders = ['', ' ', 'null', 'none', 'undefined', 'NULL', 'None', ' Undefined '];
  const fields = [
    { field: 'parent_task_id', param: 'parentTaskId', error: PARENT_TASK_ID_ERROR },
    { field: 'blocked_by_task_id', param: 'blockedByTaskId', error: BLOCKED_BY_TASK_ID_ERROR },
    { field: 'waiting_on_contact_id', param: 'waitingOnContactId', error: WAITING_ON_CONTACT_ID_ERROR },
  ] as const;
  const missingTaskId = '8c4b1e2a-0000-0000-0000-000000000000';
  const presentTaskId = '8c4b1e2a-1111-4111-8111-111111111111';

  describe.each(fields)('$field', ({ field, param, error }) => {
    it.each(placeholders)('creates the task with %j unset', async (value) => {
      const createTask = vi.fn().mockResolvedValue(makeTaskRow());
      const taskRepo = makeTaskRepo({ createTask });
      const ctx = makeCtx({ input: { title: 'Calendar reminder', [field]: value }, taskRepo });

      const result = await new TaskCreateHandler().execute(ctx);

      expect(result.success).toBe(true);
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask.mock.calls[0]![0][param]).toBeUndefined();
    });

    it('rejects a non-uuid such as "curia" and never calls the repo', async () => {
      const createTask = vi.fn();
      const taskRepo = makeTaskRepo({ createTask });
      const ctx = makeCtx({ input: { title: 'Calendar reminder', [field]: 'curia' }, taskRepo });

      const result = await new TaskCreateHandler().execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toBe(error);
      expect(createTask).not.toHaveBeenCalled();
    });
  });

  it.each(['parent_task_id', 'blocked_by_task_id'] as const)(
    'returns task not found for a missing %s and does not insert',
    async (field) => {
      const createTask = vi.fn();
      const taskRepo = makeTaskRepo({
        createTask,
        getTask: vi.fn().mockResolvedValue(null),
      });
      const ctx = makeCtx({ input: { title: 'Calendar reminder', [field]: missingTaskId }, taskRepo });

      const result = await new TaskCreateHandler().execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/task not found/i);
      expect((result as { success: false; error: string }).error).not.toMatch(/violates foreign key|invalid input syntax/i);
      expect(createTask).not.toHaveBeenCalled();
    },
  );

  it('forwards a blocker uuid when that task exists', async () => {
    const createTask = vi.fn().mockResolvedValue(makeTaskRow());
    const taskRepo = makeTaskRepo({
      createTask,
      getTask: vi.fn().mockResolvedValue(makeTaskRow({ id: presentTaskId })),
    });
    const ctx = makeCtx({
      input: { title: 'Calendar reminder', blocked_by_task_id: presentTaskId },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(createTask.mock.calls[0]![0].blockedByTaskId).toBe(presentTaskId);
  });

  it('returns contact not found for a missing waiting_on_contact_id and does not insert', async () => {
    const createTask = vi.fn();
    const contactId = '22222222-2222-4222-8222-222222222222';
    const taskRepo = makeTaskRepo({ createTask });
    const ctx = makeCtx({
      input: { title: 'Chase the vendor', waiting_on_contact_id: contactId },
      taskRepo,
      contactService: { getContact: vi.fn().mockResolvedValue(undefined) } as unknown as ToolContext['contactService'],
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/contact not found/i);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('names an unresolved contact placeholder instead of a uuid cast error', async () => {
    const createTask = vi.fn();
    const taskRepo = makeTaskRepo({ createTask });
    const ctx = makeCtx({
      input: { title: 'Chase the vendor', waiting_on_contact_id: '${principal_contact_id}' },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/Unresolved template placeholder/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('rewrites a contact foreign-key failure as contact not found', async () => {
    const contactId = '22222222-2222-4222-8222-222222222222';
    const fk = Object.assign(
      new Error('insert or update on table "tasks" violates foreign key constraint "tasks_waiting_on_contact_id_fkey"'),
      { code: '23503', constraint: 'tasks_waiting_on_contact_id_fkey' },
    );
    const taskRepo = makeTaskRepo({ createTask: vi.fn().mockRejectedValue(fk) });
    const ctx = makeCtx({
      input: { title: 'Chase the vendor', waiting_on_contact_id: contactId },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    const error = (result as { success: false; error: string }).error;
    expect(error).toMatch(/contact not found/i);
    expect(error).not.toMatch(/violates foreign key/);
  });

  it('rewrites a foreign-key failure as task not found', async () => {
    const fk = Object.assign(
      new Error('insert or update on table "tasks" violates foreign key constraint "tasks_blocked_by_task_id_fkey"'),
      { code: '23503', constraint: 'tasks_blocked_by_task_id_fkey' },
    );
    const taskRepo = makeTaskRepo({
      getTask: vi.fn().mockResolvedValue(makeTaskRow({ id: presentTaskId })),
      createTask: vi.fn().mockRejectedValue(fk),
    });
    const ctx = makeCtx({
      input: { title: 'Calendar reminder', blocked_by_task_id: presentTaskId },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    const error = (result as { success: false; error: string }).error;
    expect(error).toMatch(/task not found/i);
    expect(error).not.toMatch(/violates foreign key|invalid input syntax/);
  });
});

// #1939: agents were filling `source` with an origin identifier (agent name, job id,
// `agent:...`) because the manifest never listed the four allowed categories or
// distinguished them from source_agent_id, which the runtime records itself.
describe('task-create manifest (#1939)', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('./tool.json', import.meta.url), 'utf8'),
  ) as ToolManifest;

  it('documents the four source categories beside owner and priority', () => {
    // Each owner value says when it applies; the coordinator's prompt no longer does (prompt trim PR 3).
    expect(manifest.description).toContain('owner (ceo when the principal must act, curia when it is yours to advance, external when waiting on someone else)');
    expect(manifest.description).toContain('priority (0-100)');
    expect(manifest.description).toContain('source (ceo/agent/scheduler/coordinator)');
  });

  it('distinguishes source from the automatically recorded caller', () => {
    expect(manifest.description).toContain('source_agent_id');
    expect(manifest.description).toContain('not which agent');
    expect(manifest.inputs['source']).toContain('ceo, agent, scheduler, coordinator');
    expect(manifest.inputs['source']).toContain('source_agent_id');
    expect(manifest.inputs['source']).toContain('not which agent');
  });

  it('surfaces the source categories on the model-facing input schema', () => {
    const registry = new ToolRegistry();
    registry.register(manifest, new TaskCreateHandler());
    const tool = registry.toToolDefinitions(['task-create'])[0]!;
    const source = tool.input_schema.properties['source'] as { type: string; description?: string };
    expect(source.type).toBe('string');
    expect(source.description).toContain('ceo, agent, scheduler, coordinator');
    expect(source.description).toContain('source_agent_id');
    expect(tool.input_schema.required ?? []).not.toContain('source');
  });
});
