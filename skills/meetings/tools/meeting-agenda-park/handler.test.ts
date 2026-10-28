import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MeetingAgendaParkHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { WorkingDocRow, WorkingDocsRepo } from '../../../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });

function rowFromCreate(params: {
  path: string;
  type: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}): WorkingDocRow {
  return {
    id: 'doc-1',
    path: params.path,
    type: params.type,
    frontmatter: params.frontmatter ?? {},
    body: params.body ?? '',
    version: 1,
    sectionVersions: {},
    byteSize: 10,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-10-28T16:00:00.000Z',
    updatedAt: '2026-10-28T16:00:00.000Z',
    archivedAt: null,
  };
}

function makeCtx(input: Record<string, unknown>, repo?: WorkingDocsRepo, timezone?: string): ToolContext {
  return {
    input,
    log: silentLog,
    agentId: 'coordinator',
    timezone,
    workingDocs: repo,
  } as unknown as ToolContext;
}

describe('meeting-agenda-park', () => {
  it('parks a valid agenda and returns its path under /meetings/agendas/', async () => {
    const create = vi.fn(async (params: {
      path: string;
      type: string;
      frontmatter?: Record<string, unknown>;
      body?: string;
    }) => rowFromCreate(params));
    const repo = { create } as unknown as WorkingDocsRepo;
    const result = await new MeetingAgendaParkHandler().execute(makeCtx({
      title: 'Q3 review',
      topics: ['Pipeline'],
      context: 'Board wants a status.',
      source: 'coordinator',
    }, repo, 'America/Toronto'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { agenda_id: string; path: string; expires_at: string; displayTimezone: string };
    expect(data.path).toBe(`/meetings/agendas/${data.agenda_id}.md`);
    expect(data.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.expires_at).not.toMatch(/Z$/);
    expect(data.displayTimezone).toMatch(/UTC/);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toEqual(expect.objectContaining({
      path: data.path,
      type: 'meeting-agenda',
      taskId: null,
      body: 'Board wants a status.',
    }));
  });

  it('returns success:false with the validation error for an oversize context', async () => {
    const create = vi.fn();
    const repo = { create } as unknown as WorkingDocsRepo;
    const result = await new MeetingAgendaParkHandler().execute(makeCtx({
      title: 'Too long',
      topics: ['One'],
      context: 'c'.repeat(6001),
      source: 'principal',
    }, repo));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/6000/);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns success:false when the workingDocs capability is missing', async () => {
    const result = await new MeetingAgendaParkHandler().execute(makeCtx({
      title: 'Q3 review',
      topics: ['Pipeline'],
      context: 'Board wants a status.',
      source: 'principal',
    }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/workingDocs/);
  });
});
