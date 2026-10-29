// The send decision and the no-agenda notes path (#2347).
//
// The 2026-10-29 dry run mailed a report after two calls that loaded "Q4
// priorities", covered nothing and directed nothing (48590f8b, b3da46d0). A
// later call with no agenda asked for notes and a recap, and the pipeline
// skipped it because nothing marked the session.

import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import type { VoiceSessionRecord, VoiceSessionStore } from '../../../src/channels/voice/session-store.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import type { WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import type { Logger } from '../../../src/logger.js';
import type { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { AgendaStore } from '../../../src/meetings/agenda-store.js';
import { MinutesPipeline, recapDecision } from '../../../src/meetings/minutes-pipeline.js';
import type { AgendaSnapshot } from '../../../src/meetings/types.js';
import type { InfraLlm } from '../../../src/skills/infra-llm.js';

const SESSION_ID = 'b3da46d0-ca5a-461f-a372-330ae079a2fd';
const AGENDA_ID = '9f89bd55-85e5-4465-bd30-f8eb3eaedf88';
const STARTED = new Date('2026-10-29T14:39:24.466Z');

const q4: AgendaSnapshot = {
  agendaId: AGENDA_ID,
  title: 'Q4 priorities',
  topics: ['Top three goals for Q4', 'Biggest risk to Q4', 'What to drop'],
  role: null,
  context: 'Draw the principal out.',
  source: 'principal',
  sensitivity: 'internal',
  scheduledFor: null,
  history: [],
};

describe('recapDecision', () => {
  const untouched = [{ agendaId: AGENDA_ID, topics: q4.topics.map((topic) => ({ topic, coverage: 'not_reached' as const })) }];

  it('sends nothing for a loaded agenda nobody used (the 10:32 and 10:39 calls)', () => {
    expect(recapDecision({ notesRequested: false, coverage: untouched })).toBe('not_earned');
  });

  it('sends a recap once any topic is covered, even partly', () => {
    const partly = [{ agendaId: AGENDA_ID, topics: [{ topic: 'What to drop', coverage: 'partial' as const }] }];
    expect(recapDecision({ notesRequested: false, coverage: partly })).toBe('topic_covered');
  });

  it('sends a recap when the caller asked, whatever the coverage', () => {
    expect(recapDecision({ notesRequested: true, coverage: untouched })).toBe('requested');
    expect(recapDecision({ notesRequested: true, coverage: null })).toBe('requested');
  });

  it('leaves the call to the follow-up when coverage is unreadable', () => {
    expect(recapDecision({ notesRequested: false, coverage: null })).toBe('unknown');
  });
});

function session(metadata: Record<string, unknown>): VoiceSessionRecord {
  return {
    id: SESSION_ID,
    conversationId: `voice:${SESSION_ID}`,
    livekitRoom: 'r1',
    callerContactId: null,
    status: 'ended',
    startedAt: STARTED,
    endedAt: new Date(STARTED.getTime() + 44_000),
    endReason: 'remote_hangup',
    metadata,
  };
}

function pipeline(record: VoiceSessionRecord, minutesText: string) {
  const published: BusEvent[] = [];
  const extract = vi.fn(async (_prompt: string) => ({ ok: true, text: minutesText }));
  const created: string[] = [];
  const instance = new MinutesPipeline({
    sessionStore: { get: async () => record } as unknown as VoiceSessionStore,
    workingMemory: {
      getTranscriptRows: async () => [{
        role: 'user',
        content: 'Let\'s just check in. How\'s your day going?',
        createdAt: new Date(STARTED.getTime() + 15_000),
        senderContactId: null,
        synthetic: false,
        archived: false,
      }],
    } as unknown as WorkingMemory,
    repo: {
      existsAtPath: async () => false,
      create: async (params: { path: string }) => {
        created.push(params.path);
        return { path: params.path };
      },
    } as unknown as WorkingDocsRepo,
    agendaStore: { settle: async () => 'settled' as const } as unknown as AgendaStore,
    llm: { extract } as unknown as InfraLlm,
    taskRepo: { listTasks: async () => [] } as unknown as TaskRepo,
    contactService: { getContact: async () => undefined } as unknown as ContactService,
    bus: { publish: async (_layer: string, event: BusEvent) => { published.push(event); } } as unknown as EventBus,
    timezone: () => 'America/Toronto',
    hasActiveWake: async () => false,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger,
  });
  return { instance, published, extract, created };
}

function readyRecap(published: BusEvent[]): string | undefined {
  const ready = published.find((event) => event.type === 'minutes.ready');
  return ready?.type === 'minutes.ready' ? ready.payload.recap : undefined;
}

describe('MinutesPipeline recap and notes', () => {
  const fence = (coverage: unknown) => `## Minutes\nA check-in.\n\n\`\`\`json\n${JSON.stringify({ coverage })}\n\`\`\``;

  it('writes minutes for an untouched agenda and marks the recap not earned', async () => {
    const record = session({ agendas: [{ agendaId: AGENDA_ID, loadedAt: STARTED.toISOString(), snapshot: q4 }] });
    const { instance, published, created } = pipeline(record, fence([
      { agendaId: AGENDA_ID, topics: q4.topics.map((topic) => ({ topic, coverage: 'not_reached' })) },
    ]));
    expect(await instance.run(SESSION_ID)).toBe('completed');
    expect(created).toContain(`/meetings/minutes/2026-10-29-${SESSION_ID}.md`);
    expect(readyRecap(published)).toBe('not_earned');
  });

  it('writes minutes for a notes request with no agenda and marks the recap requested', async () => {
    const record = session({ notes: { requestedAt: STARTED.toISOString() } });
    const { instance, published, extract, created } = pipeline(record, fence([]));
    expect(await instance.run(SESSION_ID)).toBe('completed');
    expect(extract.mock.calls[0]?.[0]).toContain('No agenda was set.');
    expect(created).toContain(`/meetings/minutes/2026-10-29-${SESSION_ID}.md`);
    expect(readyRecap(published)).toBe('requested');
  });

  it('skips a call with neither an agenda nor a notes request', async () => {
    const { instance, published, extract } = pipeline(session({}), fence([]));
    expect(await instance.run(SESSION_ID)).toBe('skipped');
    expect(extract).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });
});
