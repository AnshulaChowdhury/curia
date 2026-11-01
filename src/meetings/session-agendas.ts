// session-agendas.ts — what a principal call starts with (#2322).
//
// Cull, then lock only when the single pending agenda is due. One that is not
// due, or several pending agendas, stay an index. A store failure yields an
// empty session so the call still starts free-form.

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
    const only = pending.length === 1 ? pending[0]! : null;
    if (!only || !isDue(only, opts.now)) {
      return { agendas: indexOf(pending), preload: null };
    }
    const target = only;
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
