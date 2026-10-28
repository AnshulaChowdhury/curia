import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dashboardRoutes } from '../../../../src/channels/http/routes/dashboard.js';
import { BriefingService, type BriefingDeps } from '../../../../src/dashboard/briefing-service.js';
import { createSilentLogger } from '../../../../src/logger.js';

const SECRET = 'dashboard-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET };
const TASK_ID = '22222222-2222-2222-2222-222222222222';

let app: FastifyInstance | undefined;

function briefing(overrides: Partial<BriefingDeps> = {}): BriefingService {
  const deps: BriefingDeps = {
    pool: { query: vi.fn().mockResolvedValue({ rows: [{ n: 0 }] }) } as unknown as BriefingDeps['pool'],
    auditLogRepo: { findActivityJobs: vi.fn() },
    actionLogRepo: {
      findAllPending: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      resolveRow: vi.fn(),
      rejectStaleApproval: vi.fn(),
      insert: vi.fn(),
    },
    taskRepo: { listTasks: vi.fn().mockResolvedValue([]), updateTask: vi.fn() },
    contactService: { findContactBySystemRole: vi.fn().mockResolvedValue({ id: 'p', timezone: 'UTC' }) },
    officeTimezone: 'UTC',
    logger: createSilentLogger(),
    ...overrides,
  };
  return new BriefingService(deps);
}

async function build(service: BriefingService) {
  app = Fastify();
  await app.register(dashboardRoutes, {
    briefing: service,
    webAppBootstrapSecret: SECRET,
    sessions: new Map(),
    logger: createSilentLogger(),
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('dashboard routes', () => {
  it('rejects unauthenticated reads and writes', async () => {
    const updateTask = vi.fn();
    const service = briefing({ taskRepo: { listTasks: vi.fn(), updateTask } });
    const server = await build(service);
    for (const url of ['/api/dashboard/waiting', '/api/dashboard/stats', '/api/dashboard/histogram', '/api/dashboard/bullpen']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
    const cancel = await server.inject({ method: 'POST', url: `/api/dashboard/tasks/${TASK_ID}/cancel` });
    expect(cancel.statusCode).toBe(401);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('cancels a task through TaskRepo.updateTask', async () => {
    // Wake-up cancellation, child reconciliation and outreach close live in
    // TaskRepo.updateTask (see tests/integration/task-update-wake-reuse.test.ts).
    // This route's job is to get there instead of writing the row itself.
    const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID, status: 'cancelled' });
    const server = await build(briefing({ taskRepo: { listTasks: vi.fn(), updateTask } }));
    const res = await server.inject({
      method: 'POST',
      url: `/api/dashboard/tasks/${TASK_ID}/cancel`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { status: 'cancelled' }, 'console');
  });

  it('marks a task done through the same path', async () => {
    const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID, status: 'done' });
    const server = await build(briefing({ taskRepo: { listTasks: vi.fn(), updateTask } }));
    const res = await server.inject({
      method: 'POST',
      url: `/api/dashboard/tasks/${TASK_ID}/done`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { status: 'done' }, 'console');
  });

  it('returns 400 for a non-uuid task id and does not touch the repo', async () => {
    const updateTask = vi.fn();
    const server = await build(briefing({ taskRepo: { listTasks: vi.fn(), updateTask } }));
    const res = await server.inject({ method: 'POST', url: '/api/dashboard/tasks/nope/cancel', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('returns a generic 500 when the waiting query fails', async () => {
    const service = briefing({
      taskRepo: { listTasks: vi.fn().mockRejectedValue(new Error('relation missing')), updateTask: vi.fn() },
    });
    const server = await build(service);
    const res = await server.inject({ method: 'GET', url: '/api/dashboard/waiting', headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to load what is waiting on you' });
  });

  it('does not report the bullpen as zero when the count query fails', async () => {
    const service = briefing({
      pool: { query: vi.fn().mockRejectedValue(new Error('audit_log missing')) } as unknown as BriefingDeps['pool'],
    });
    const server = await build(service);
    const res = await server.inject({ method: 'GET', url: '/api/dashboard/bullpen', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ available: false, count: 0, agents: [] });
  });
});
