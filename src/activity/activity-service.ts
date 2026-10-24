// activity-service.ts — reads and projects the console activity feed (#2251).
//
// Read path for GET /api/activity: newest jobs from audit_log, names and job
// labels resolved in one batch, then the pure projection. It makes no model
// calls: conversational summaries were written once, at job completion, by
// ActivitySummarizer, and are read back here as activity.summary rows.

import type { AuditLogRepo } from '../audit/audit-log-repo.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { ActionLogRow } from '../autonomy/action-log-types.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { Logger } from '../logger.js';
import { isUuid } from '../util/uuid.js';
import { collectActivityRefs, projectActivity, type ActivityRows } from './projection.js';
import type { ActivityPage } from './types.js';

export interface ActivityServiceDeps {
  auditLogRepo: Pick<AuditLogRepo, 'findActivityJobs'>;
  actionLogRepo?: Pick<ActionLogRepo, 'findTerminalBetween'>;
  contactService: Pick<ContactService, 'getContact' | 'findContactBySystemRole' | 'resolveByChannelIdentity'>;
  schedulerService?: Pick<SchedulerService, 'getJob'>;
  /** Office timezone (config.timezone), used when the principal has none. */
  officeTimezone: string;
  logger: Logger;
}

/** Shape the console reads; also the service's public read contract. */
export interface ActivityFeedSource {
  list(query: { from: Date; to: Date; limit: number }): Promise<ActivityPage>;
}

/**
 * Roots read per requested item. Many jobs project to nothing (plumbing-only
 * turns, inbound mail Curia didn't answer), so read more than asked for.
 */
const ROOTS_PER_ITEM = 4;
const MAX_ROOTS = 200;
/** Cap on distinct names resolved per request — each is a DB round-trip. */
const MAX_NAME_LOOKUPS = 100;
const JOB_LABEL_MAX = 60;

/** A short label for a scheduled job: its task title, else the first sentence of its task. */
export function jobLabelFrom(job: { taskTitle: string | null; taskPayload: Record<string, unknown> }): string | null {
  const title = job.taskTitle?.trim();
  const raw = title && title.length > 0
    ? title
    : typeof job.taskPayload.task === 'string' ? job.taskPayload.task : '';
  const firstSentence = raw.split(/(?<=[.!?])\s|\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const sentence = firstSentence.replace(/[.!?]+$/, '');
  if (sentence.length === 0) return null;
  return sentence.length > JOB_LABEL_MAX ? `${sentence.slice(0, JOB_LABEL_MAX - 1)}…` : sentence;
}

export class ActivityService implements ActivityFeedSource {
  constructor(private readonly deps: ActivityServiceDeps) {}

  async list(query: { from: Date; to: Date; limit: number }): Promise<ActivityPage> {
    const { deps } = this;
    const rows: ActivityRows & { hasMore: boolean } = await deps.auditLogRepo.findActivityJobs({
      from: query.from,
      to: query.to,
      limit: Math.min(query.limit * ROOTS_PER_ITEM, MAX_ROOTS),
    });

    const principal = await this.lookup('principal contact', () => deps.contactService.findContactBySystemRole('principal'));
    const timezone = principal?.timezone ?? deps.officeTimezone;

    const refs = collectActivityRefs(rows);
    const [names, jobLabels, autonomyRows] = await Promise.all([
      this.resolveNames(refs.names, principal?.displayName ?? null),
      this.resolveJobLabels(refs.jobIds),
      this.loadAutonomyRows(query.from),
    ]);

    const items = projectActivity(rows, {
      timezone,
      name: (ref) => names.get(ref) ?? null,
      jobLabel: (jobId) => jobLabels.get(jobId) ?? null,
      autonomyRows,
    });

    return {
      items: items.slice(0, query.limit),
      hasMore: rows.hasMore || items.length > query.limit,
      timezone,
    };
  }

  /** Run one lookup; a failure degrades that name to its fallback, logged. */
  private async lookup<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.deps.logger.warn({ err, what }, 'activity: lookup failed, falling back');
      return null;
    }
  }

  private async resolveNames(refs: Set<string>, principalName: string | null): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (principalName) names.set('principal', principalName);
    const pending = [...refs].filter((r) => r !== 'principal').slice(0, MAX_NAME_LOOKUPS);
    if (refs.size > MAX_NAME_LOOKUPS) {
      this.deps.logger.warn({ refs: refs.size, cap: MAX_NAME_LOOKUPS }, 'activity: too many names to resolve; the rest fall back');
    }
    await Promise.all(pending.map(async (ref) => {
      if (ref.startsWith('email:')) {
        const sender = await this.lookup('contact by email', () =>
          this.deps.contactService.resolveByChannelIdentity('email', ref.slice('email:'.length)));
        if (sender?.displayName) names.set(ref, sender.displayName);
        return;
      }
      // Anything else a describer returns is a contact id; skip non-ids rather
      // than hand the contacts table a malformed key.
      if (!isUuid(ref)) return;
      const contact = await this.lookup('contact by id', () => this.deps.contactService.getContact(ref));
      if (contact?.displayName) names.set(ref, contact.displayName);
    }));
    return names;
  }

  private async resolveJobLabels(jobIds: Set<string>): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const scheduler = this.deps.schedulerService;
    if (!scheduler) return labels;
    await Promise.all([...jobIds].map(async (jobId) => {
      const job = await this.lookup('scheduled job', () => scheduler.getJob(jobId));
      const label = job ? jobLabelFrom(job) : null;
      if (label) labels.set(jobId, label);
    }));
    return labels;
  }

  private async loadAutonomyRows(from: Date): Promise<ActionLogRow[]> {
    if (!this.deps.actionLogRepo) return [];
    // Until now, not the window end: an approval can land after the job's window.
    const rows = await this.lookup('autonomy action log', () => this.deps.actionLogRepo!.findTerminalBetween(from, new Date()));
    return rows ?? [];
  }
}
