// minutes-pipeline.ts — transcript, minutes, and agenda settlement when a call ends (#2322).
//
// Each step is idempotent. A second run finds the docs already written. Minutes
// that already exist have unknown coverage, so a not-yet-settled agenda returns
// to pending with every topic not_reached. `run` never rejects.

import { DateTime } from 'luxon';
import type { EventBus } from '../bus/bus.js';
import { createMinutesPipelineFailed, createMinutesReady } from '../bus/events.js';
import type { VoiceSessionRecord, VoiceSessionStore } from '../channels/voice/session-store.js';
import { sessionAgendaLoads } from '../channels/voice/session-store.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { WorkingMemory } from '../memory/working-memory.js';
import type { InfraLlm } from '../skills/infra-llm.js';
import type { AgendaStore } from './agenda-store.js';
import { writeMinutes } from './minutes-writer.js';
import { buildTranscriptDoc, callerSpokeAfter, transcriptPath } from './transcript.js';
import type { AgendaCoverage, AgendaSensitivity, AgendaSnapshot, SessionAgendaLoad } from './types.js';
import { SENSITIVITY_RANK } from './types.js';

export type MinutesPipelineOutcome = 'skipped' | 'returned_unused' | 'completed' | 'failed';

type FailureStage = 'transcript' | 'minutes' | 'settle' | 'structuring';

export interface MinutesPipelineDeps {
  sessionStore: VoiceSessionStore;
  workingMemory: WorkingMemory;
  repo: WorkingDocsRepo;
  agendaStore: AgendaStore;
  llm: InfraLlm;
  taskRepo: TaskRepo;
  contactService: ContactService;
  bus: EventBus;
  timezone: () => string;
  logger: Logger;
}

export function minutesPath(sessionId: string, startedAt: Date, tz: string): string {
  const date = DateTime.fromJSDate(startedAt).setZone(tz).toISODate()
    ?? DateTime.fromJSDate(startedAt).toUTC().toISODate()
    ?? 'unknown-date';
  return `/meetings/minutes/${date}-${sessionId}.md`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function strictest(agendas: AgendaSnapshot[]): AgendaSensitivity {
  let best: AgendaSensitivity = 'shareable';
  for (const agenda of agendas) {
    if (SENSITIVITY_RANK[agenda.sensitivity] > SENSITIVITY_RANK[best]) best = agenda.sensitivity;
  }
  return agendas.length === 0 ? 'internal' : best;
}

function uniqueSources(agendas: AgendaSnapshot[]): AgendaSnapshot['source'][] {
  const seen = new Set<AgendaSnapshot['source']>();
  const sources: AgendaSnapshot['source'][] = [];
  for (const agenda of agendas) {
    if (seen.has(agenda.source)) continue;
    seen.add(agenda.source);
    sources.push(agenda.source);
  }
  return sources;
}

function everyTopicCovered(coverage: AgendaCoverage | undefined): boolean {
  return !!coverage && coverage.topics.length > 0 && coverage.topics.every((topic) => topic.coverage === 'covered');
}

export class MinutesPipeline {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: MinutesPipelineDeps) {}

  async run(sessionId: string): Promise<MinutesPipelineOutcome> {
    if (this.inFlight.has(sessionId)) return 'skipped';
    this.inFlight.add(sessionId);
    try {
      return await this.execute(sessionId);
    } catch (err) {
      this.deps.logger.error({ err, sessionId }, 'meeting pipeline: run failed');
      await this.publishFailed(sessionId, 'transcript', err instanceof Error ? err.message : String(err));
      return 'failed';
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async execute(sessionId: string): Promise<MinutesPipelineOutcome> {
    const session = await this.deps.sessionStore.get(sessionId);
    if (!session) return 'skipped';
    const loads = sessionAgendaLoads(session);
    if (loads.length === 0) return 'skipped';

    const rows = await this.deps.workingMemory.getTranscriptRows(session.conversationId, 'coordinator');
    const counted = loads.filter((load) => callerSpokeAfter(rows, new Date(load.loadedAt)));
    if (counted.length === 0) {
      for (const load of loads) {
        await this.deps.agendaStore.settle(load.agendaId, sessionId, { kind: 'return' });
      }
      return 'returned_unused';
    }

    let stage: FailureStage = 'transcript';
    try {
      const callerName = await this.callerName(session);
      const built = buildTranscriptDoc({ session, loads, rows, callerName });
      const tPath = transcriptPath(session.id);
      await this.writeIfAbsent(tPath, 'meeting-transcript', built.frontmatter, built.body);

      stage = 'minutes';
      const mPath = minutesPath(session.id, session.startedAt, this.deps.timezone());
      const snapshots = counted.map((load) => load.snapshot);
      const minutesAlreadyWritten = await this.deps.repo.existsAtPath(mPath);
      let coverage: AgendaCoverage[] | null = null;
      if (!minutesAlreadyWritten) {
        const written = await writeMinutes(this.deps.llm, {
          agendas: snapshots,
          transcriptBody: built.body,
        });
        if (!written.ok) {
          this.deps.logger.error({ sessionId, error: written.error }, 'meeting pipeline: minutes writer failed');
          await this.publishFailed(sessionId, 'minutes', written.error);
          return 'failed';
        }
        coverage = written.coverage;
        if (coverage === null) {
          this.deps.logger.warn(
            { sessionId },
            'meeting pipeline: minutes had no parseable coverage; returning every agenda to pending',
          );
        }
        await this.writeIfAbsent(mPath, 'meeting-minutes', {
          session_id: session.id,
          agenda_ids: snapshots.map((agenda) => agenda.agendaId),
          sources: uniqueSources(snapshots),
          sensitivity: strictest(snapshots),
          transcript_ref: tPath,
          started_at: session.startedAt.toISOString(),
        }, written.markdown);
      }

      stage = 'settle';
      await this.settleLoads(session, loads, counted, coverage);

      stage = 'structuring';
      const tag = `meeting-minutes:${session.id}`;
      const existing = await this.deps.taskRepo.listTasks({ tag });
      if (existing.length === 0) {
        await this.deps.bus.publish('system', createMinutesReady({
          minutesRef: mPath,
          sessionId: session.id,
          conversationId: session.conversationId,
          sources: uniqueSources(snapshots),
          sensitivity: strictest(snapshots),
        }));
      }
      return 'completed';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err, sessionId, stage }, 'meeting pipeline: stage failed');
      await this.publishFailed(sessionId, stage, message);
      return 'failed';
    }
  }

  private async settleLoads(
    session: VoiceSessionRecord,
    loads: SessionAgendaLoad[],
    counted: SessionAgendaLoad[],
    coverage: AgendaCoverage[] | null,
  ): Promise<void> {
    const countedIds = new Set(counted.map((load) => load.agendaId));
    const byAgenda = new Map((coverage ?? []).map((entry) => [entry.agendaId, entry]));
    for (const load of loads) {
      if (!countedIds.has(load.agendaId)) {
        await this.deps.agendaStore.settle(load.agendaId, session.id, { kind: 'return' });
        continue;
      }
      const entry = coverage === null ? undefined : byAgenda.get(load.agendaId);
      if (everyTopicCovered(entry)) {
        await this.deps.agendaStore.settle(load.agendaId, session.id, { kind: 'done' });
        continue;
      }
      const topics = load.snapshot.topics.map((topic) => ({
        topic,
        coverage: entry?.topics.find((row) => row.topic === topic)?.coverage ?? 'not_reached',
      }));
      await this.deps.agendaStore.settle(load.agendaId, session.id, {
        kind: 'return',
        history: {
          sessionId: session.id,
          date: session.startedAt.toISOString(),
          topics,
        },
      });
    }
  }

  private async callerName(session: VoiceSessionRecord): Promise<string> {
    if (!session.callerContactId) return 'Caller';
    try {
      const contact = await this.deps.contactService.getContact(session.callerContactId);
      if (contact?.displayName) return contact.displayName;
    } catch (err) {
      this.deps.logger.warn({ err, sessionId: session.id }, 'meeting transcript: caller name lookup failed');
    }
    return 'Caller';
  }

  private async writeIfAbsent(
    path: string,
    type: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    if (await this.deps.repo.existsAtPath(path)) return;
    try {
      await this.deps.repo.create({ path, type, frontmatter, body, taskId: null });
    } catch (err) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
  }

  private async publishFailed(sessionId: string, stage: FailureStage, error: string): Promise<void> {
    try {
      await this.deps.bus.publish('system', createMinutesPipelineFailed({ sessionId, stage, error }));
    } catch (err) {
      this.deps.logger.error({ err, sessionId, stage }, 'meeting pipeline: failed to publish minutes.pipeline_failed');
    }
  }
}
