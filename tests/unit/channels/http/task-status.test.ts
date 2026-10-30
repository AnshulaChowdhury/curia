// PATCH /api/tasks/:id status changes go through TaskRepo.updateTask (#2340).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskRoutes } from '../../../../src/channels/http/routes/tasks.js';
import { TaskTerminalStateError } from '../../../../src/db/task-repo.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { Pool } from 'pg';
import { createSilentLogger } from '../../../../src/logger.js';

const SECRET = 'kg-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET, 'content-type': 'application/json' };
const TASK_ID = '33333333-3333-4333-8333-333333333333';

const EXISTING = {
  id: TASK_ID,
  agent_id: 'coordinator',
  title: 'Sign off',
  intent_anchor: 'sign off',
  description: null,
  status: 'open',
  owner: 'ceo',
  priority: 50,
  due_at: '2026-10-26T12:00:00.000Z',
  source: 'ceo',
  source_agent_id: null,
  tags: [],
  waiting_on_contact_id: null,
  waiting_on_text: null,
  parent_task_id: null,
  blocked_by_task_id: null,
  progress: {},
  error_budget: {},
  conversation_id: null,
  created_at: '2026-10-20T00:00:00.000Z',
  updated_at: '2026-10-20T00:00:00.000Z',
};

let app: FastifyInstance | undefined;

function pool(): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM tasks WHERE id')) return { rows: [EXISTING], rowCount: 1 };
    if (sql.includes('UPDATE tasks')) return { rows: [{ ...EXISTING, status: 'cancelled' }], rowCount: 1 };
    if (sql.includes('LEFT JOIN contacts')) return { rows: [{ ...EXISTING, status: 'cancelled', waiting_on_contact_name: null, next_wake_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { query, connect: vi.fn() } as unknown as Pool;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('taskRoutes — PATCH /api/tasks/:id status', () => {
  it('routes a cancel through TaskRepo.updateTask before the field update', async () => {
    const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID, status: 'cancelled' });
    app = Fastify();
    await app.register(taskRoutes, {
      pool: pool(),
      logger: createSilentLogger(),
      webAppBootstrapSecret: SECRET,
      contactService: {} as ContactService,
      sessions: new Map(),
      taskRepo: { updateTask },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TASK_ID}`,
      headers: AUTH,
      payload: { status: 'cancelled' },
    });
    expect(res.statusCode).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { status: 'cancelled' }, 'console');
  });

  it('returns 400 for a typed terminal-state error and 500 for other failures', async () => {
    const updateTask = vi.fn().mockRejectedValue(new TaskTerminalStateError('done'));
    app = Fastify();
    await app.register(taskRoutes, {
      pool: pool(),
      logger: createSilentLogger(),
      webAppBootstrapSecret: SECRET,
      contactService: {} as ContactService,
      sessions: new Map(),
      taskRepo: { updateTask },
    });
    const terminal = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TASK_ID}`,
      headers: AUTH,
      payload: { status: 'cancelled' },
    });
    expect(terminal.statusCode).toBe(400);

    updateTask.mockRejectedValue(new Error("Cannot transition task from 'done' — it is a terminal state."));
    const unmatched = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TASK_ID}`,
      headers: AUTH,
      payload: { status: 'cancelled' },
    });
    expect(unmatched.statusCode).toBe(500);
  });

  it('refuses a status change when TaskRepo is not wired', async () => {
    app = Fastify();
    await app.register(taskRoutes, {
      pool: pool(),
      logger: createSilentLogger(),
      webAppBootstrapSecret: SECRET,
      contactService: {} as ContactService,
      sessions: new Map(),
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TASK_ID}`,
      headers: AUTH,
      payload: { status: 'done' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('requires auth', async () => {
    const updateTask = vi.fn();
    app = Fastify();
    await app.register(taskRoutes, {
      pool: pool(),
      logger: createSilentLogger(),
      webAppBootstrapSecret: SECRET,
      contactService: {} as ContactService,
      sessions: new Map(),
      taskRepo: { updateTask },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${TASK_ID}`,
      headers: { 'content-type': 'application/json' },
      payload: { status: 'cancelled' },
    });
    expect(res.statusCode).toBe(401);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
