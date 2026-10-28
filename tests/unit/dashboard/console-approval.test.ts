import { describe, expect, it, vi } from 'vitest';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import { RESOLVED_BY } from '../../../src/autonomy/action-log-types.js';
import { approveFromConsole, denyFromConsole, type ConsoleApprovalDeps } from '../../../src/dashboard/console-approval.js';
import { createSilentLogger } from '../../../src/logger.js';

function row(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 7,
    taskId: '11111111-1111-1111-1111-111111111111',
    conversationId: null,
    toolName: 'send-draft',
    actionRisk: 'medium',
    outcome: 'pending_approval',
    taskSummary: null,
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: { draft_id: 'draft-1', account: 'ops', subject: 'Renewal' },
    notificationSentAt: new Date('2026-10-28T12:00:00.000Z'),
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    parentActionId: null,
    shortRef: 'abc',
    approvalNumber: 3,
    description: 'Reply to vendor',
    createdAt: new Date('2026-10-28T10:00:00.000Z'),
    ...overrides,
  };
}

function deps(overrides: Partial<ConsoleApprovalDeps> = {}): ConsoleApprovalDeps & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    actionLogRepo: {
      resolveRow: vi.fn(async () => {
        order.push('resolve');
        return true;
      }),
      rejectStaleApproval: vi.fn(async () => true),
      insert: vi.fn(async () => 1),
    },
    executionLayer: {
      invoke: vi.fn(async () => {
        order.push('invoke');
        return { success: true as const, data: {} };
      }),
      confirmPinnedSendResolution: vi.fn(async () => ({ ok: true as const })),
    },
    deleteMailboxDraft: vi.fn(async () => {
      order.push('delete');
    }),
    principalContactId: 'principal-1',
    logger: createSilentLogger(),
    ...overrides,
  };
}

describe('denyFromConsole', () => {
  it('deletes the mailbox draft and never runs the tool', async () => {
    const d = deps();
    const result = await denyFromConsole(row(), d);
    expect(result).toEqual({ ok: true, sent: false });
    expect(d.order).toEqual(['delete', 'resolve']);
    expect(d.executionLayer!.invoke).not.toHaveBeenCalled();
    expect(d.actionLogRepo.resolveRow).toHaveBeenCalledWith(7, 'denied', RESOLVED_BY.console);
    expect(d.deleteMailboxDraft).toHaveBeenCalledWith('ops', 'draft-1');
  });

  it('leaves the row pending when the draft delete fails', async () => {
    const d = deps({
      deleteMailboxDraft: vi.fn(async () => {
        throw new Error('nylas down');
      }),
    });
    const result = await denyFromConsole(row(), d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
    expect(d.actionLogRepo.resolveRow).not.toHaveBeenCalled();
    expect(d.executionLayer!.invoke).not.toHaveBeenCalled();
  });
});

describe('approveFromConsole', () => {
  it('resolves as console and re-runs the blocked tool', async () => {
    const d = deps();
    const result = await approveFromConsole(row({ toolName: 'email-send', payload: { subject: 'Hi' } }), d);
    expect(result).toEqual({ ok: true, sent: true });
    expect(d.order).toEqual(['resolve', 'invoke']);
    expect(d.deleteMailboxDraft).not.toHaveBeenCalled();
    expect(d.actionLogRepo.resolveRow).toHaveBeenCalledWith(7, 'approved', RESOLVED_BY.console);
    expect(d.executionLayer!.invoke).toHaveBeenCalledWith(
      'email-send',
      { subject: 'Hi' },
      { contactId: 'principal-1', role: 'ceo', channel: 'web' },
      expect.objectContaining({ humanApproved: true, taskEventId: row().taskId }),
    );
  });

  it('does not re-run when the row was already resolved', async () => {
    const d = deps();
    d.actionLogRepo.resolveRow = vi.fn(async () => false);
    const result = await approveFromConsole(row({ toolName: 'email-send', payload: { subject: 'Hi' } }), d);
    expect(result.ok).toBe(false);
    expect(d.executionLayer!.invoke).not.toHaveBeenCalled();
  });
});
