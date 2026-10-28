// recovery.ts — startup sweep for calls that died before minutes.ready (#2322).
//
// Rerun recent ended sessions, cull expired agendas, then release an in_call
// agenda whose session is gone. A rerun that completed or returned the agenda
// unused is left alone. A failed rerun is released so the agenda is not stuck.

import type { VoiceSessionStore } from '../channels/voice/session-store.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { Logger } from '../logger.js';
import { parseAgendaDoc, type AgendaStore } from './agenda-store.js';
import type { MinutesPipeline, MinutesPipelineOutcome } from './minutes-pipeline.js';

const DEFAULT_LOOKBACK_DAYS = 7;
const AGENDA_PREFIX = '/meetings/agendas/';
const DAY_MS = 24 * 60 * 60 * 1000;

export class MeetingPipelineRecovery {
  private readonly lookbackDays: number;

  constructor(private readonly deps: {
    sessionStore: VoiceSessionStore;
    agendaStore: AgendaStore;
    repo: WorkingDocsRepo;
    pipeline: MinutesPipeline;
    logger: Logger;
    lookbackDays?: number;
  }) {
    this.lookbackDays = deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  }

  async sweep(now: Date): Promise<{ rerun: number; released: number }> {
    const since = new Date(now.getTime() - this.lookbackDays * DAY_MS);
    const sessions = await this.deps.sessionStore.listRecentWithAgendas(since);
    const protectedIds = new Set<string>();
    let rerun = 0;
    for (const session of sessions) {
      rerun += 1;
      let outcome: MinutesPipelineOutcome = 'failed';
      try {
        outcome = await this.deps.pipeline.run(session.id);
      } catch (err) {
        this.deps.logger.error({ err, sessionId: session.id }, 'meeting recovery: pipeline run rejected');
      }
      if (outcome === 'completed' || outcome === 'returned_unused') protectedIds.add(session.id);
    }

    await this.deps.agendaStore.cullExpired(now);

    let released = 0;
    const rows = await this.deps.repo.listByPrefix(AGENDA_PREFIX);
    for (const row of rows) {
      if (!row.path.startsWith(AGENDA_PREFIX)) continue;
      const doc = parseAgendaDoc(row);
      if (!doc || doc.status !== 'in_call' || !doc.inCallSession) continue;
      if (protectedIds.has(doc.inCallSession)) continue;
      const session = await this.deps.sessionStore.get(doc.inCallSession);
      if (session && (session.status === 'active' || session.status === 'starting')) continue;
      const result = await this.deps.agendaStore.settle(doc.agendaId, doc.inCallSession, { kind: 'return' });
      if (result === 'settled') released += 1;
    }
    return { rerun, released };
  }
}
