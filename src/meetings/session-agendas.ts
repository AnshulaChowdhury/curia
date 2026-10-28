// session-agendas.ts — what a principal call starts with (#2322).
//
// Cull, then either lock the single due agenda or offer the pending index.
// A store failure yields an empty session so the call still starts free-form.

import type { Logger } from '../logger.js';
import type { AgendaStore } from './agenda-store.js';
import { agendaSnapshot } from './agenda-store.js';
import { isDue } from './agenda-validation.js';
import type { AgendaDoc, SessionAgendaLoad, SessionAgendas } from './types.js';

function empty(): { agendas: SessionAgendas; preload: SessionAgendaLoad | null } {
  return { agendas: { loaded: [], index: [] }, preload: null };
}

function indexOf(pending: AgendaDoc[]): SessionAgendas {
  return {
    loaded: [],
    index: pending.map((doc) => ({
      agendaId: doc.agendaId,
      title: doc.title,
      scheduledFor: doc.scheduledFor,
    })),
  };
}

export async function prepareSessionAgendas(
  store: AgendaStore,
  opts: { sessionId: string; now: Date; logger: Logger },
): Promise<{ agendas: SessionAgendas; preload: SessionAgendaLoad | null }> {
  try {
    await store.cullExpired(opts.now);
    const pending = await store.listPending(opts.now);
    const due = pending.filter((doc) => isDue(doc, opts.now));
    if (due.length !== 1) {
      return { agendas: indexOf(pending), preload: null };
    }
    const target = due[0]!;
    const locked = await store.lock(target.agendaId, opts.sessionId, opts.now);
    if (!locked.ok) {
      return { agendas: indexOf(pending), preload: null };
    }
    const snapshot = agendaSnapshot(locked.agenda);
    const preload: SessionAgendaLoad = {
      agendaId: snapshot.agendaId,
      loadedAt: opts.now.toISOString(),
      snapshot,
    };
    return {
      agendas: { loaded: [snapshot], index: [] },
      preload,
    };
  } catch (err) {
    opts.logger.error({ err, sessionId: opts.sessionId }, 'meeting agendas: preparation failed');
    return empty();
  }
}
