import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EventBus } from '../../../src/bus/bus.js';
import { createMinutesReady, createVoiceSessionEnded } from '../../../src/bus/events.js';
import { replaceActiveSkillsBlock } from '../../../src/db/active-skills-progress.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';
import { MINUTES_STRUCTURING_SKILL } from '../../../src/meetings/minutes-task.js';
import type { MinutesPipeline } from '../../../src/meetings/minutes-pipeline.js';
import { MeetingSessionEndedSubscriber, MinutesReadySubscriber } from '../../../src/meetings/subscribers.js';
import type { SchedulerService } from '../../../src/scheduler/scheduler-service.js';

describe('MeetingSessionEndedSubscriber', () => {
  it('voice.session.ended handler returns before the pipeline settles', async () => {
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pipeline = {
      run: () => {
        started = true;
        return gate.then(() => 'completed' as const);
      },
    } as unknown as MinutesPipeline;
    const bus = new EventBus(createSilentLogger());
    new MeetingSessionEndedSubscriber({ bus, pipeline, logger: createSilentLogger() }).start();

    await bus.publish('system', createVoiceSessionEnded({
      sessionId: 'sess',
      conversationId: 'voice:sess',
      reason: 'remote_hangup',
    }));

    expect(started).toBe(true);
    release();
    await gate;
  });

  it('a rejected pipeline run is logged, not thrown', async () => {
    const error = vi.fn();
    const logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger;
    const pipeline = {
      run: async () => {
        throw new Error('boom');
      },
    } as unknown as MinutesPipeline;
    const bus = new EventBus(createSilentLogger());
    new MeetingSessionEndedSubscriber({ bus, pipeline, logger }).start();

    await expect(bus.publish('system', createVoiceSessionEnded({
      sessionId: 'sess',
      conversationId: 'voice:sess',
      reason: 'remote_hangup',
    }))).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalled();
  });
});

function fakePool(): Pool {
  const client = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  };
  return { connect: async () => client } as unknown as Pool;
}

function task(overrides: { id?: string; status?: string; progress?: Record<string, unknown> } = {}) {
  return {
    id: overrides.id ?? 'task-1',
    status: overrides.status ?? 'open',
    progress: overrides.progress ?? {},
  };
}

describe('MinutesReadySubscriber', () => {
  const payload = {
    minutesRef: '/meetings/minutes/2026-10-28-sess.md',
    sessionId: 'sess',
    conversationId: 'voice:sess',
    sources: ['principal' as const],
    sensitivity: 'internal' as const,
  };

  function start(opts: {
    tasks: Array<ReturnType<typeof task>>;
    hasActiveWake?: (taskId: string) => Promise<boolean>;
    enqueue?: () => Promise<{ jobId: string }>;
  }) {
    const failed: string[] = [];
    const created: string[] = [];
    const skills: string[] = [];
    const wakes: string[] = [];
    const bus = new EventBus(createSilentLogger());
    bus.subscribe('minutes.pipeline_failed', 'system', (event) => {
      if (event.type === 'minutes.pipeline_failed') failed.push(event.payload.sessionId);
    });
    const taskRepo = {
      listTasks: async () => opts.tasks,
      createTask: async () => {
        const createdTask = task({ id: 'created-1' });
        opts.tasks.push(createdTask);
        created.push(createdTask.id);
        return createdTask;
      },
      setActiveSkillsBlock: async (taskId: string) => {
        skills.push(taskId);
        return { task: task({ id: taskId }), block: replaceActiveSkillsBlock([MINUTES_STRUCTURING_SKILL]) };
      },
    } as unknown as TaskRepo;
    const scheduler = {
      enqueueTaskWake: async (params: { taskId: string }) => {
        wakes.push(params.taskId);
        if (opts.enqueue) return opts.enqueue();
        return { jobId: 'wake-1' };
      },
    } as unknown as SchedulerService;
    new MinutesReadySubscriber({
      bus,
      taskRepo,
      schedulerService: scheduler,
      logger: createSilentLogger(),
      pool: fakePool(),
      hasActiveWake: opts.hasActiveWake ?? (async () => false),
    }).start();
    return { bus, failed, created, skills, wakes };
  }

  it('restores the skill and enqueues one wake for an existing open task', async () => {
    const existing = task();
    const { bus, created, skills, wakes, failed } = start({ tasks: [existing] });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual([]);
    expect(skills).toEqual(['task-1']);
    expect(wakes).toEqual(['task-1']);
    expect(failed).toEqual([]);
  });

  it('leaves a task that already has the skill and an active wake', async () => {
    const existing = task({
      progress: {
        activeSkills: {
          skills: [{ name: MINUTES_STRUCTURING_SKILL, activatedAt: '2026-10-28T12:00:00.000Z' }],
        },
      },
    });
    const { bus, created, skills, wakes } = start({
      tasks: [existing],
      hasActiveWake: async () => true,
    });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual([]);
    expect(skills).toEqual([]);
    expect(wakes).toEqual([]);
  });

  it('does not create or wake a terminal task', async () => {
    const { bus, created, skills, wakes } = start({
      tasks: [task({ status: 'done' })],
    });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual([]);
    expect(skills).toEqual([]);
    expect(wakes).toEqual([]);
  });

  it('treats a unique-violation as success when an active wake is already there', async () => {
    let checks = 0;
    const { bus, failed, wakes } = start({
      tasks: [],
      hasActiveWake: async () => {
        checks += 1;
        return checks > 1;
      },
      enqueue: async () => {
        throw Object.assign(new Error('dup'), { code: '23505' });
      },
    });
    await bus.publish('system', createMinutesReady(payload));
    expect(wakes).toEqual(['created-1']);
    expect(failed).toEqual([]);
  });
});
