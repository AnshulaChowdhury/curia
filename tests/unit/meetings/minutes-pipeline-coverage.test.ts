import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../../src/bus/bus.js';
import type { VoiceSessionRecord, VoiceSessionStore } from '../../../src/channels/voice/session-store.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import type { WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import type { Logger } from '../../../src/logger.js';
import type { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { AgendaStore } from '../../../src/meetings/agenda-store.js';
import { MinutesPipeline } from '../../../src/meetings/minutes-pipeline.js';
import type { InfraLlm } from '../../../src/skills/infra-llm.js';
import type { AgendaSnapshot } from '../../../src/meetings/types.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const AGENDA_ID = '11111111-1111-4111-8111-111111111111';
const STARTED = new Date('2026-10-28T16:00:00.000Z');

const snapshot: AgendaSnapshot = {
  agendaId: AGENDA_ID,
  title: 'Board',
  topics: ['runway'],
  role: null,
  context: 'Cover runway.',
  source: 'principal',
  sensitivity: 'internal',
  scheduledFor: null,
  history: [],
};

function session(): VoiceSessionRecord {
  return {
    id: SESSION_ID,
    conversationId: 'c1',
    livekitRoom: 'r1',
    callerContactId: null,
    status: 'ended',
    startedAt: STARTED,
    endedAt: STARTED,
    endReason: 'remote_hangup',
    metadata: {
      agendas: [{ agendaId: AGENDA_ID, loadedAt: STARTED.toISOString(), snapshot }],
    },
  };
}

describe('MinutesPipeline coverage', () => {
  it('warns when minutes have no parseable coverage and returns the agenda to pending', async () => {
    const warn = vi.fn();
    const settle = vi.fn(async () => 'settled' as const);
    const pipeline = new MinutesPipeline({
      sessionStore: { get: async () => session() } as unknown as VoiceSessionStore,
      workingMemory: {
        getTranscriptRows: async () => [{
          role: 'user',
          content: 'Let us cover runway.',
          createdAt: new Date(STARTED.getTime() + 1000),
          senderContactId: null,
          synthetic: false,
          archived: false,
        }],
      } as unknown as WorkingMemory,
      repo: {
        existsAtPath: async () => false,
        create: async () => ({ path: 'written' }),
      } as unknown as WorkingDocsRepo,
      agendaStore: { settle } as unknown as AgendaStore,
      llm: {
        extract: async () => ({ ok: true, text: '## Minutes\nDiscussed runway with no fence.' }),
      } as unknown as InfraLlm,
      taskRepo: { listTasks: async () => [] } as unknown as TaskRepo,
      contactService: { getContact: async () => undefined } as unknown as ContactService,
      bus: { publish: async () => {} } as unknown as EventBus,
      timezone: () => 'America/Toronto',
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });

    expect(await pipeline.run(SESSION_ID)).toBe('completed');
    expect(warn).toHaveBeenCalledWith(
      { sessionId: SESSION_ID },
      'meeting pipeline: minutes had no parseable coverage; returning every agenda to pending',
    );
    expect(settle).toHaveBeenCalledWith(AGENDA_ID, SESSION_ID, {
      kind: 'return',
      history: {
        sessionId: SESSION_ID,
        date: STARTED.toISOString(),
        topics: [{ topic: 'runway', coverage: 'not_reached' }],
      },
    });
  });
});
