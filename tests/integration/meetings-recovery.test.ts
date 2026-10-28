// Startup sweep recovers a call that died before minutes.ready (#2322).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { AuditLogger } from '../../src/audit/logger.js';
import { EventBus } from '../../src/bus/bus.js';
import type { MinutesReadyEvent } from '../../src/bus/events.js';
import { VoiceSessionStore } from '../../src/channels/voice/session-store.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import { createLogger } from '../../src/logger.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { AgendaStore, agendaSnapshot } from '../../src/meetings/agenda-store.js';
import { minutesPath, MinutesPipeline } from '../../src/meetings/minutes-pipeline.js';
import { transcriptPath } from '../../src/meetings/transcript.js';
import { MeetingPipelineRecovery } from '../../src/meetings/recovery.js';
import { MinutesReadySubscriber } from '../../src/meetings/subscribers.js';
import type { InfraLlm } from '../../src/skills/infra-llm.js';
import type { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const TZ = 'America/Toronto';
const DAY = 24 * 60 * 60 * 1000;

describeIf('MeetingPipelineRecovery (integration, #2322)', () => {
  let publicPool: pg.Pool;
  let isolated: IsolatedWorkingDocsStore;
  let sessions: VoiceSessionStore;
  let memory: WorkingMemory;
  let repo: WorkingDocsRepo;
  let agendas: AgendaStore;
  let tasks: TaskRepo;
  let recovery: MeetingPipelineRecovery;
  let ready: MinutesReadyEvent[];
  const prompts: string[] = [];
  const sessionIds: string[] = [];

  beforeAll(async () => {
    publicPool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(publicPool);
    isolated = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    const logger = createLogger('error');
    const audit = new AuditLogger(publicPool, logger);
    const bus = new EventBus(logger, (event) => audit.log(event), (eventId) => audit.markAcknowledged(eventId));
    ready = [];
    bus.subscribe('minutes.ready', 'system', (event) => {
      if (event.type === 'minutes.ready') ready.push(event);
    });
    sessions = new VoiceSessionStore(publicPool);
    memory = WorkingMemory.createWithPostgres(publicPool, logger);
    repo = new WorkingDocsRepo(isolated.pool, logger);
    agendas = new AgendaStore(repo, logger);
    tasks = new TaskRepo(publicPool, bus, logger, TZ);
    const llm: InfraLlm = {
      classify: async () => ({ ok: true, text: '' }),
      extract: async (prompt) => {
        prompts.push(prompt);
        const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(prompt)?.[0] ?? '';
        return {
          ok: true,
          text: [
            '## Board',
            'Discussed.',
            '',
            '```json',
            JSON.stringify({ coverage: [{ agendaId: id, topics: [{ topic: 'runway', coverage: 'partial' }] }] }),
            '```',
          ].join('\n'),
        };
      },
    };
    const pipeline = new MinutesPipeline({
      sessionStore: sessions,
      workingMemory: memory,
      repo,
      agendaStore: agendas,
      llm,
      taskRepo: tasks,
      contactService: { getContact: async () => undefined } as unknown as ContactService,
      bus,
      timezone: () => TZ,
      logger,
    });
    const scheduler = { enqueueTaskWake: async () => ({ jobId: 'wake-1' }) } as unknown as SchedulerService;
    new MinutesReadySubscriber({ bus, taskRepo: tasks, schedulerService: scheduler, logger }).start();
    recovery = new MeetingPipelineRecovery({
      sessionStore: sessions,
      agendaStore: agendas,
      repo,
      pipeline,
      logger,
      lookbackDays: 7,
    });
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await publicPool.query('DELETE FROM working_memory WHERE conversation_id = ANY($1::text[])', [
        sessionIds.map((id) => `meetings-2322:${id}`),
      ]);
      await publicPool.query('DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE created_by = $1)', ['meetings']);
      await publicPool.query('DELETE FROM tasks WHERE created_by = $1', ['meetings']);
      await publicPool.query('DELETE FROM voice_sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
    }
    await isolated?.drop();
    await publicPool?.end();
  });

  async function endedCall(marker: string): Promise<{ sessionId: string; agendaId: string; startedAt: Date }> {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const parked = await agendas.park({
      title: 'Board',
      topics: ['runway'],
      context: marker,
      source: 'principal',
      sensitivity: 'confidential',
      expiresAt: new Date(Date.now() + 7 * DAY),
      scheduledFor: null,
      role: null,
    }, new Date());
    const session = await sessions.create({
      id: sessionId,
      conversationId: `meetings-2322:${sessionId}`,
      livekitRoom: `meetings-2322:${sessionId}`,
    });
    const locked = await agendas.lock(parked.agendaId, sessionId, new Date());
    if (!locked.ok) throw new Error(locked.reason);
    await sessions.appendAgendaLoad(sessionId, {
      agendaId: parked.agendaId,
      loadedAt: session.startedAt.toISOString(),
      snapshot: agendaSnapshot(locked.agenda),
    });
    await memory.addTurn(`meetings-2322:${sessionId}`, 'coordinator', { role: 'user', content: marker }, {
      createdAt: new Date(session.startedAt.getTime() + 1000),
    });
    return { sessionId, agendaId: parked.agendaId, startedAt: session.startedAt };
  }

  it('failed/process_restart session with a counted agenda gets transcript, minutes and minutes.ready from the sweep', async () => {
    const { sessionId } = await endedCall('RESTART-MARKER');
    await publicPool.query(
      `UPDATE voice_sessions SET status = 'failed', end_reason = 'process_restart', ended_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    await recovery.sweep(new Date());
    const session = await sessions.get(sessionId);
    expect(await repo.read(transcriptPath(sessionId))).not.toBeNull();
    expect(await repo.read(minutesPath(sessionId, session!.startedAt, TZ))).not.toBeNull();
    expect(ready.some((event) => event.payload.sessionId === sessionId)).toBe(true);
    expect(await tasks.listTasks({ tag: `meeting-minutes:${sessionId}` })).toHaveLength(1);
  });

  it('crash after minutes before minutes.ready is completed by the sweep', async () => {
    const { sessionId, agendaId, startedAt } = await endedCall('CRASH-MARKER');
    const path = minutesPath(sessionId, startedAt, TZ);
    await repo.create({
      path,
      type: 'meeting-minutes',
      taskId: null,
      body: 'ALREADY WRITTEN',
      frontmatter: { session_id: sessionId },
    });
    await publicPool.query(
      `UPDATE voice_sessions SET status = 'ended', end_reason = 'remote_hangup', ended_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    const promptsBefore = prompts.length;
    await recovery.sweep(new Date());
    const minutes = await repo.read(path);
    expect(minutes?.body).toBe('ALREADY WRITTEN');
    expect(prompts.slice(promptsBefore).join('\n')).not.toContain('CRASH-MARKER');
    expect(ready.some((event) => event.payload.sessionId === sessionId)).toBe(true);
    const agenda = await agendas.get(agendaId);
    expect(agenda?.status).toBe('pending');
    expect(agenda?.history[0]?.topics).toEqual([{ topic: 'runway', coverage: 'not_reached' }]);
  });

  it('archived minutes and transcript are not rewritten', async () => {
    const { sessionId, startedAt } = await endedCall('ARCHIVE-MARKER');
    await publicPool.query(
      `UPDATE voice_sessions SET status = 'ended', end_reason = 'remote_hangup', ended_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    await recovery.sweep(new Date());
    const minutes = minutesPath(sessionId, startedAt, TZ);
    const transcript = transcriptPath(sessionId);
    expect(await repo.softDelete(minutes)).not.toBeNull();
    expect(await repo.softDelete(transcript)).not.toBeNull();
    expect(await repo.read(minutes)).toBeNull();
    const promptsBefore = prompts.length;
    await recovery.sweep(new Date());
    expect(prompts.slice(promptsBefore).join('\n')).not.toContain('ARCHIVE-MARKER');
    expect(await repo.read(minutes)).toBeNull();
    expect(await repo.read(transcript)).toBeNull();
    expect(await repo.existsAtPath(minutes)).toBe(true);
    expect(await repo.existsAtPath(transcript)).toBe(true);
  });

  it('releases an in_call agenda the completed session never recorded', async () => {
    const { sessionId, agendaId: recordedId } = await endedCall('RECORDED-MARKER');
    const extra = await agendas.park({
      title: 'Unrecorded',
      topics: ['side'],
      context: 'Locked but not in metadata.',
      source: 'ad_hoc',
      sensitivity: 'shareable',
      expiresAt: new Date(Date.now() + 7 * DAY),
      scheduledFor: null,
      role: null,
    }, new Date());
    const locked = await agendas.lock(extra.agendaId, sessionId, new Date());
    if (!locked.ok) throw new Error(locked.reason);
    await publicPool.query(
      `UPDATE voice_sessions SET status = 'ended', end_reason = 'remote_hangup', ended_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    await recovery.sweep(new Date());
    const unrecorded = await agendas.get(extra.agendaId);
    expect(unrecorded?.status).toBe('pending');
    expect(unrecorded?.inCallSession).toBeNull();
    expect(unrecorded?.history).toEqual([]);
    const recorded = await agendas.get(recordedId);
    expect(recorded?.status).toBe('pending');
    expect(recorded?.history.length).toBeGreaterThan(0);
  });

  it('orphaned in_call agenda is released', async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const parked = await agendas.park({
      title: 'Orphan',
      topics: ['runway'],
      context: 'No load recorded.',
      source: 'ad_hoc',
      sensitivity: 'shareable',
      expiresAt: new Date(Date.now() + 7 * DAY),
      scheduledFor: null,
      role: null,
    }, new Date());
    await sessions.create({
      id: sessionId,
      conversationId: `meetings-2322:${sessionId}`,
      livekitRoom: `meetings-2322:${sessionId}`,
    });
    const locked = await agendas.lock(parked.agendaId, sessionId, new Date());
    if (!locked.ok) throw new Error(locked.reason);
    await sessions.endSession(sessionId, 'remote_hangup');
    await recovery.sweep(new Date());
    const agenda = await agendas.get(parked.agendaId);
    expect(agenda?.status).toBe('pending');
    expect(agenda?.inCallSession).toBeNull();
  });

  it('sweep ignores sessions older than the lookback', async () => {
    const { sessionId, startedAt } = await endedCall('OLD-MARKER');
    const old = new Date(Date.now() - 8 * DAY);
    await publicPool.query(
      `UPDATE voice_sessions SET status = 'ended', end_reason = 'remote_hangup', ended_at = NOW(), started_at = $2 WHERE id = $1`,
      [sessionId, old],
    );
    await recovery.sweep(new Date());
    const session = await sessions.get(sessionId);
    expect(session!.startedAt.getTime()).toBeLessThan(Date.now() - 7 * DAY);
    expect(await repo.read(minutesPath(sessionId, session!.startedAt, TZ))).toBeNull();
    expect(await repo.read(transcriptPath(sessionId))).toBeNull();
    void startedAt;
  });
});
