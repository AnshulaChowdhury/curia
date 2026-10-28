// briefing-service.ts — reads and actions for the principal home (#2340).
//
// Each method backs one console card. A failure throws (or, for the bullpen,
// reports unavailable) so the card can show an error instead of a false zero.

import type { Pool } from 'pg';
import type { AuditLogRepo } from '../audit/audit-log-repo.js';
import { projectActivity } from '../activity/projection.js';
import { OPEN_TASK_STATUSES } from '../agents/prompts/backlog-line.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { DisclosureDecisionRecorder } from '../autonomy/disclosure-decisions.js';
import type { EventBus } from '../bus/bus.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { ExecutionLayer } from '../skills/execution.js';
import {
  AGGREGATE_MAX_PAGES,
  AGGREGATE_PAGE_ROOTS,
  BULLPEN_IN_FLIGHT_MS,
  HISTOGRAM_DAYS,
  MINUTES_PER_SUCCESSFUL_ACTION,
  STATS_WINDOW_DAYS,
  addCalendarDays,
  approvalReviewSummary,
  countJobs,
  hiccupsOver,
  isValidTimeZone,
  localDayKey,
  localMidnight,
  shapeHistogram,
  type HistogramModel,
  type ProjectedJob,
} from './briefing.js';
import { approveFromConsole, denyFromConsole, type ApprovalOutcome } from './console-approval.js';

const CLEARED_BY = ['principal', 'console', 'ceo'];
const DONE_OUTCOMES = new Set(['success', 'partial'] as const);

export interface WaitingTask {
  id: string;
  title: string;
  dueAt: string;
}

export interface WaitingApproval {
  id: number;
  title: string;
  createdAt: string;
  toolName: string;
  summary: string;
}

export interface WaitingResponse {
  timezone: string;
  tasks: WaitingTask[];
  approvals: WaitingApproval[];
  clearedToday: number;
  curiaHandling: number;
}

export interface StatsResponse {
  timezone: string;
  /** Echo of {@link MINUTES_PER_SUCCESSFUL_ACTION} so the console does not keep a second copy. */
  minutesPerAction: number;
  successfulActions: { current: number; previous: number };
  done: { current: number; previous: number };
  contacts: { total: number; newThisWeek: number };
  hiccups: { current: number; byDay: number[] };
  handledSinceYesterday: number;
}

export interface BullpenResponse {
  available: boolean;
  count: number;
  agents: string[];
}

export interface BriefingDeps {
  pool: Pool;
  auditLogRepo: Pick<AuditLogRepo, 'findActivityJobs'>;
  actionLogRepo: Pick<ActionLogRepo, 'findAllPending' | 'findById' | 'resolveRow' | 'rejectStaleApproval' | 'insert'>;
  taskRepo: Pick<TaskRepo, 'listTasks' | 'updateTask'>;
  contactService: Pick<ContactService, 'findContactBySystemRole'>;
  executionLayer?: Pick<ExecutionLayer, 'invoke' | 'confirmPinnedSendResolution'>;
  disclosureDecisions?: Pick<DisclosureDecisionRecorder, 'recordForApproval'>;
  deleteMailboxDraft?: (account: string | undefined, draftId: string) => Promise<void>;
  bus?: Pick<EventBus, 'publish'>;
  officeTimezone: string;
  logger: Logger;
}

export class BriefingService {
  constructor(private readonly deps: BriefingDeps) {}

  async waiting(now: Date = new Date()): Promise<WaitingResponse> {
    const timezone = await this.timeZone();
    const todayStart = localMidnight(localDayKey(now, timezone), timezone);
    const [tasks, approvals, clearedTasks, clearedApprovals, curiaHandling] = await Promise.all([
      this.deps.taskRepo.listTasks({
        owner: 'ceo',
        statuses: [...OPEN_TASK_STATUSES],
        dueBefore: now,
        limit: 100,
      }),
      this.deps.actionLogRepo.findAllPending(),
      this.count(
        `SELECT count(*)::int AS n FROM tasks
         WHERE owner = 'ceo' AND status IN ('done', 'cancelled') AND updated_at >= $1`,
        [todayStart],
      ),
      this.count(
        `SELECT count(*)::int AS n FROM autonomy_action_log
         WHERE outcome IN ('approved', 'denied', 'resolved_externally')
           AND resolved_at >= $1
           AND resolved_by = ANY($2::text[])`,
        [todayStart, CLEARED_BY],
      ),
      this.count(
        `SELECT count(*)::int AS n FROM tasks
         WHERE owner = 'curia' AND status = ANY($1::text[])`,
        [OPEN_TASK_STATUSES],
      ),
    ]);

    const waitingTasks: WaitingTask[] = tasks
      .filter((task): task is typeof task & { dueAt: string } => typeof task.dueAt === 'string')
      .map((task) => ({
        id: task.id,
        title: task.title.trim() || task.intentAnchor,
        dueAt: task.dueAt,
      }))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

    const waitingApprovals: WaitingApproval[] = approvals
      .map((row) => ({
        id: row.id,
        title: row.description?.trim() || row.toolName,
        createdAt: row.createdAt.toISOString(),
        toolName: row.toolName,
        summary: approvalReviewSummary(row),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      timezone,
      tasks: waitingTasks,
      approvals: waitingApprovals,
      clearedToday: clearedTasks + clearedApprovals,
      curiaHandling,
    };
  }

  async stats(now: Date = new Date()): Promise<StatsResponse> {
    const timezone = await this.timeZone();
    const { jobs, model } = await this.aggregate(now, timezone);
    const last7 = new Set(model.days.slice(-STATS_WINDOW_DAYS).map((day) => day.key));
    const prev7 = new Set(model.days.slice(0, HISTOGRAM_DAYS - STATS_WINDOW_DAYS).map((day) => day.key));
    const sinceYesterday = new Set(model.days.slice(-2).map((day) => day.key));
    const currentStart = localMidnight(model.days[HISTOGRAM_DAYS - STATS_WINDOW_DAYS]!.key, timezone);
    const previousStart = localMidnight(model.days[0]!.key, timezone);

    const [actions, contacts] = await Promise.all([
      this.actionCounts(previousStart, currentStart, now),
      this.contactCounts(currentStart),
    ]);

    return {
      timezone,
      minutesPerAction: MINUTES_PER_SUCCESSFUL_ACTION,
      successfulActions: actions,
      done: {
        current: countJobs(jobs, last7, timezone, DONE_OUTCOMES),
        previous: countJobs(jobs, prev7, timezone, DONE_OUTCOMES),
      },
      contacts,
      hiccups: {
        current: hiccupsOver(model, STATS_WINDOW_DAYS),
        byDay: model.days.map((day) => day.hiccups),
      },
      handledSinceYesterday: countJobs(jobs, sinceYesterday, timezone),
    };
  }

  async histogram(now: Date = new Date()): Promise<HistogramModel & { timezone: string }> {
    const timezone = await this.timeZone();
    const { model } = await this.aggregate(now, timezone);
    return { timezone, ...model };
  }

  /**
   * Distinct agents with an in-flight root task. A failed read reports
   * unavailable so the card keeps its static copy instead of a made-up count.
   */
  async bullpen(now: Date = new Date()): Promise<BullpenResponse> {
    try {
      const since = new Date(now.getTime() - BULLPEN_IN_FLIGHT_MS);
      const result = await this.deps.pool.query<{ agent: string }>(
        `SELECT COALESCE(NULLIF(r.payload->>'agentId', ''), r.source_id) AS agent
         FROM audit_log r
         WHERE r.event_type = 'agent.task'
           AND r.timestamp >= $1
           AND (r.payload->'metadata'->'delegationOrigin'->>'taskEventId') IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM audit_log c
             WHERE c.parent_event_id = r.id::text
               AND c.event_type = 'agent.response'
           )
         GROUP BY 1
         ORDER BY count(*) DESC, agent ASC`,
        [since],
      );
      const agents = result.rows.map((row) => row.agent).filter((agent) => agent.length > 0);
      return { available: true, count: agents.length, agents };
    } catch (err) {
      this.deps.logger.error({ err }, 'briefing: bullpen count failed — static copy');
      return { available: false, count: 0, agents: [] };
    }
  }

  async setTaskStatus(id: string, status: 'done' | 'cancelled'): Promise<ApprovalOutcome> {
    try {
      const updated = await this.deps.taskRepo.updateTask(id, { status }, 'console');
      if (!updated) return { ok: false, status: 404, error: 'Task not found.' };
      return { ok: true, sent: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('terminal state')) return { ok: false, status: 400, error: message };
      this.deps.logger.error({ err, taskId: id }, 'briefing: task status update failed');
      return { ok: false, status: 500, error: 'Failed to update task.' };
    }
  }

  async approve(id: number): Promise<ApprovalOutcome> {
    return this.resolveApproval(id, 'approve');
  }

  async deny(id: number): Promise<ApprovalOutcome> {
    return this.resolveApproval(id, 'deny');
  }

  private async resolveApproval(id: number, action: 'approve' | 'deny'): Promise<ApprovalOutcome> {
    const row = await this.deps.actionLogRepo.findById(id);
    if (!row) return { ok: false, status: 404, error: 'Approval not found.' };
    const principalContactId = await this.principalId();
    const deps = { ...this.deps, principalContactId };
    return action === 'approve' ? approveFromConsole(row, deps) : denyFromConsole(row, deps);
  }

  private async aggregate(now: Date, timezone: string): Promise<{ jobs: ProjectedJob[]; model: HistogramModel }> {
    const from = localMidnight(
      addCalendarDays(localDayKey(now, timezone), -(HISTOGRAM_DAYS - 1)),
      timezone,
    );
    const jobs = await this.loadJobs(from, now, timezone);
    return { jobs, model: shapeHistogram(jobs, now, timezone) };
  }

  private async loadJobs(from: Date, to: Date, timezone: string): Promise<ProjectedJob[]> {
    const jobs: ProjectedJob[] = [];
    let before: { timestamp: Date; id: string } | undefined;
    for (let page = 0; page < AGGREGATE_MAX_PAGES; page++) {
      const result = await this.deps.auditLogRepo.findActivityJobs({
        from,
        to,
        limit: AGGREGATE_PAGE_ROOTS,
        ...(before ? { before } : {}),
      });
      const items = projectActivity(result, {
        timezone,
        name: () => null,
        jobLabel: () => null,
        autonomyRows: [],
      });
      for (const item of items) {
        jobs.push({ ts: item.ts, actor: item.actor, outcome: item.outcome });
      }
      if (!result.hasMore || !result.nextCursor) return jobs;
      before = result.nextCursor;
    }
    this.deps.logger.error({ from, to, pages: AGGREGATE_MAX_PAGES }, 'briefing: activity aggregate truncated');
    throw new Error('activity window exceeded the aggregate page bound');
  }

  private async actionCounts(
    previousStart: Date,
    currentStart: Date,
    now: Date,
  ): Promise<{ current: number; previous: number }> {
    const result = await this.deps.pool.query<{ current: number; previous: number }>(
      `SELECT
         count(*) FILTER (WHERE timestamp >= $2 AND timestamp < $3)::int AS current,
         count(*) FILTER (WHERE timestamp >= $1 AND timestamp < $2)::int AS previous
       FROM audit_log
       WHERE event_type = ANY($4::text[])
         AND timestamp >= $1 AND timestamp < $3
         AND (
           outcome = 'success'
           OR (outcome IS NULL AND payload->'result'->>'success' = 'true')
         )`,
      [previousStart, currentStart, now, ['tool.result', 'skill.result']],
    );
    const row = result.rows[0];
    return {
      current: Number(row?.current ?? 0),
      previous: Number(row?.previous ?? 0),
    };
  }

  private async contactCounts(since: Date): Promise<{ total: number; newThisWeek: number }> {
    const result = await this.deps.pool.query<{ total: number; recent: number }>(
      `SELECT
         count(*) FILTER (WHERE kind = 'person')::int AS total,
         count(*) FILTER (WHERE kind = 'person' AND created_at >= $1)::int AS recent
       FROM contacts`,
      [since],
    );
    const row = result.rows[0];
    return { total: Number(row?.total ?? 0), newThisWeek: Number(row?.recent ?? 0) };
  }

  private async count(sql: string, params: unknown[]): Promise<number> {
    const result = await this.deps.pool.query<{ n: number }>(sql, params);
    return Number(result.rows[0]?.n ?? 0);
  }

  private async timeZone(): Promise<string> {
    try {
      const principal = await this.deps.contactService.findContactBySystemRole('principal');
      const zone = principal?.timezone;
      if (zone && isValidTimeZone(zone)) return zone;
    } catch (err) {
      this.deps.logger.warn({ err }, 'briefing: principal timezone lookup failed');
    }
    return isValidTimeZone(this.deps.officeTimezone) ? this.deps.officeTimezone : 'UTC';
  }

  private async principalId(): Promise<string | null> {
    try {
      const principal = await this.deps.contactService.findContactBySystemRole('principal');
      return principal?.id ?? null;
    } catch (err) {
      this.deps.logger.warn({ err }, 'briefing: principal lookup failed');
      return null;
    }
  }
}
