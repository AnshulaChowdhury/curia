import { describe, expect, it, vi } from 'vitest';
import { ActivityService, jobLabelFrom, type ActivityServiceDeps } from '../../../src/activity/activity-service.js';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

const T0 = new Date('2026-10-24T13:00:00.000Z');
const CONTACT_ID = '7f1c0c1e-0000-4000-8000-000000000001';
const JOB_ID = '0b8f2f8e-1f7a-4c3e-9a51-3f0e2a1d4c55';

function row(overrides: Partial<AuditLogRow> & Pick<AuditLogRow, 'id' | 'eventType'>): AuditLogRow {
  return {
    timestamp: T0, sourceLayer: 'agent', sourceId: 'coordinator', conversationId: 'conv-1', taskId: null,
    parentEventId: null, payload: {}, action: null, outcome: null, targetType: null, targetId: null,
    initiatorType: null, initiatorId: null, entryHash: null, ...overrides,
  };
}

function deps(overrides: Partial<ActivityServiceDeps> = {}): ActivityServiceDeps {
  const roots = [
    row({ id: 't1', eventType: 'agent.task', payload: { agentId: 'coordinator', channelId: 'email' } }),
    row({ id: 't2', eventType: 'agent.task', conversationId: `scheduler:${JOB_ID}:r1`, payload: { agentId: 'ceo-inbox', channelId: 'scheduler' } }),
  ];
  const children = [
    row({ id: 'i1', eventType: 'tool.invoke', parentEventId: 't1', payload: { toolName: 'email-send', input: { to: CONTACT_ID } } }),
    row({ id: 'r1', eventType: 'tool.result', parentEventId: 'i1', outcome: 'success', payload: { toolName: 'email-send', result: { success: true, data: {} } } }),
    row({ id: 'i2', eventType: 'tool.invoke', parentEventId: 't1', payload: { toolName: 'ceo-inbox-draft-reply', input: {} } }),
    row({ id: 'r2', eventType: 'tool.result', parentEventId: 'i2', outcome: 'success', payload: { toolName: 'ceo-inbox-draft-reply', result: { success: true, data: { to: [{ email: 'john@example.com' }] } } } }),
    row({ id: 'i3', eventType: 'tool.invoke', parentEventId: 't2', payload: { toolName: 'ceo-inbox-archive', input: {} } }),
    row({ id: 'r3', eventType: 'tool.result', parentEventId: 'i3', outcome: 'success', payload: { toolName: 'ceo-inbox-archive', result: { success: true, data: {} } } }),
  ];
  return {
    auditLogRepo: { findActivityJobs: vi.fn().mockResolvedValue({ roots, delegated: [], children, hasMore: false }) },
    actionLogRepo: { findTerminalBetween: vi.fn().mockResolvedValue([]) },
    contactService: {
      getContact: vi.fn().mockImplementation(async (id: string) => (id === CONTACT_ID ? { displayName: 'Jane Roe' } : undefined)),
      findContactBySystemRole: vi.fn().mockResolvedValue({ displayName: 'Joseph', timezone: 'America/Toronto' }),
      resolveByChannelIdentity: vi.fn().mockImplementation(async (_c: string, addr: string) => (addr === 'john@example.com' ? { displayName: 'John Doe' } : null)),
    } as unknown as ActivityServiceDeps['contactService'],
    schedulerService: { getJob: vi.fn().mockResolvedValue({ taskTitle: null, taskPayload: { task: 'Triage the principal\'s inbox. Archive newsletters.' } }) } as unknown as ActivityServiceDeps['schedulerService'],
    officeTimezone: 'UTC',
    logger: createSilentLogger(),
    ...overrides,
  };
}

describe('ActivityService', () => {
  it('resolves names and job labels, and reports the principal timezone', async () => {
    const d = deps();
    const page = await new ActivityService(d).list({ from: new Date(T0.getTime() - 86_400_000), to: T0, limit: 20 });
    expect(page.timezone).toBe('America/Toronto');
    expect(page.items.map((i) => i.headline)).toEqual([
      'sent an email, drafted a reply',
      "Triage the principal's inbox: archived an email",
    ]);
    expect(page.items[0]!.details).toEqual(['emailed Jane Roe', 'drafted a reply to John Doe']);
    expect(d.contactService.resolveByChannelIdentity).toHaveBeenCalledWith('email', 'john@example.com');
    expect(d.auditLogRepo.findActivityJobs).toHaveBeenCalledWith(expect.objectContaining({ limit: 80 }));
  });

  it('falls back to the office timezone and to addresses when lookups fail', async () => {
    const d = deps({
      contactService: {
        getContact: vi.fn().mockRejectedValue(new Error('db down')),
        findContactBySystemRole: vi.fn().mockRejectedValue(new Error('db down')),
        resolveByChannelIdentity: vi.fn().mockRejectedValue(new Error('db down')),
      } as unknown as ActivityServiceDeps['contactService'],
    });
    const warn = vi.spyOn(d.logger, 'warn');
    const page = await new ActivityService(d).list({ from: new Date(0), to: T0, limit: 20 });
    expect(page.timezone).toBe('UTC');
    expect(page.items[0]!.details).toEqual(['emailed a contact', 'drafted a reply to john@example.com']);
    expect(warn).toHaveBeenCalled();
  });

  it('trims to the limit and reports more', async () => {
    const page = await new ActivityService(deps()).list({ from: new Date(0), to: T0, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });
});

describe('jobLabelFrom', () => {
  it('prefers the task title, else the first sentence of the task, capped', () => {
    expect(jobLabelFrom({ taskTitle: 'Morning brief', taskPayload: { task: 'x' } })).toBe('Morning brief');
    expect(jobLabelFrom({ taskTitle: null, taskPayload: { task: 'Check the inbox. Then rest.' } })).toBe('Check the inbox');
    expect(jobLabelFrom({ taskTitle: null, taskPayload: {} })).toBeNull();
    expect(jobLabelFrom({ taskTitle: 'x'.repeat(100), taskPayload: {} })!.length).toBe(60);
  });
});
