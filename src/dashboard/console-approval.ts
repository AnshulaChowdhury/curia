// console-approval.ts — approve or discard a held action from the principal home (#2340).
//
// Same steps as approve-action / deny-action, with resolved_by 'console' because
// the principal clicked in the web console rather than reacting in chat.
// A held send-draft is deleted before the row is denied, so the message cannot go out.

import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { ActionLogRow } from '../autonomy/action-log-types.js';
import { RESOLVED_BY } from '../autonomy/action-log-types.js';
import { hasPersonalDetails, UNSHOWN_PERSONAL_DETAILS_ERROR } from '../autonomy/approval-notification.js';
import type { DisclosureDecisionRecorder } from '../autonomy/disclosure-decisions.js';
import type { EventBus } from '../bus/bus.js';
import { createHumanDecision } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ExecutionLayer } from '../skills/execution.js';
import { STALE_SEND_APPROVAL_ERROR } from '../skills/_shared/recipient-reference.js';
import { mailboxDraftRef } from './briefing.js';

export type ApprovalOutcome =
  | { ok: true; sent: boolean }
  | { ok: false; status: number; error: string };

export interface ConsoleApprovalDeps {
  actionLogRepo: Pick<ActionLogRepo, 'resolveRow' | 'rejectStaleApproval' | 'insert'>;
  executionLayer?: Pick<ExecutionLayer, 'invoke' | 'confirmPinnedSendResolution'>;
  disclosureDecisions?: Pick<DisclosureDecisionRecorder, 'recordForApproval'>;
  deleteMailboxDraft?: (account: string | undefined, draftId: string) => Promise<void>;
  bus?: Pick<EventBus, 'publish'>;
  principalContactId: string | null;
  logger: Logger;
}

function stillPending(row: ActionLogRow, now: Date): ApprovalOutcome | null {
  if (row.outcome !== 'pending_approval') {
    return { ok: false, status: 409, error: 'That item is no longer waiting.' };
  }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, status: 409, error: 'That approval has expired.' };
  }
  return null;
}

async function publishDecision(
  deps: ConsoleApprovalDeps,
  row: ActionLogRow,
  decision: 'approve' | 'deny',
): Promise<void> {
  if (!deps.bus || !deps.principalContactId) return;
  try {
    await deps.bus.publish('system', createHumanDecision({
      decision,
      deciderId: deps.principalContactId,
      deciderChannel: 'web',
      subjectEventId: row.taskId,
      subjectSummary: `principal ${decision === 'approve' ? 'approved' : 'denied'} from the console: ${row.description ?? row.toolName}`,
      contextShown: ['description', 'skill_name'],
      presentedAt: row.createdAt,
      decidedAt: new Date(),
      defaultAction: 'block',
      parentEventId: row.taskId,
    }));
  } catch (err) {
    deps.logger.error({ err, rowId: row.id }, 'console-approval: failed to publish human.decision');
  }
}

async function rememberDisclosure(
  deps: ConsoleApprovalDeps,
  row: ActionLogRow,
  decision: 'yes' | 'no',
): Promise<void> {
  if (!row.disclosureAsk || row.notificationSentAt === null) return;
  if (!deps.disclosureDecisions) {
    deps.logger.error({ rowId: row.id }, 'console-approval: disclosureDecisions not wired — the decision is not remembered for the thread');
    return;
  }
  // The disclosure table only records reaction or coordinator paths. The console
  // is the principal deciding, same as a coordinator-mediated answer.
  await deps.disclosureDecisions.recordForApproval(row, decision, 'principal_via_coordinator');
}

/**
 * Approve a pending row and re-run the blocked tool. Not undoable: the send may already have left.
 */
export async function approveFromConsole(
  row: ActionLogRow,
  deps: ConsoleApprovalDeps,
  now: Date = new Date(),
): Promise<ApprovalOutcome> {
  const blocked = stillPending(row, now);
  if (blocked) return blocked;
  if (!row.payload) {
    return { ok: false, status: 400, error: 'This approval has nothing stored to run.' };
  }
  if (!deps.executionLayer) {
    return { ok: false, status: 503, error: 'Approvals cannot be sent right now.' };
  }
  if (!deps.principalContactId) {
    return { ok: false, status: 503, error: 'No principal is configured.' };
  }

  if (row.notificationSentAt === null && (row.disclosureAsk || hasPersonalDetails(row.toolName, row.payload))) {
    return { ok: false, status: 409, error: UNSHOWN_PERSONAL_DETAILS_ERROR };
  }

  const pins = row.sendResolution;
  if (pins && pins.length > 0) {
    const still = await deps.executionLayer.confirmPinnedSendResolution(row.toolName, pins);
    if (!still.ok) {
      await deps.actionLogRepo.rejectStaleApproval(row.id);
      return { ok: false, status: 409, error: STALE_SEND_APPROVAL_ERROR };
    }
  }

  const transitioned = await deps.actionLogRepo.resolveRow(row.id, 'approved', RESOLVED_BY.console);
  if (!transitioned) {
    return { ok: false, status: 409, error: 'That item is no longer waiting.' };
  }

  await rememberDisclosure(deps, row, 'yes');

  const reResult = await deps.executionLayer.invoke(
    row.toolName,
    row.payload,
    { contactId: deps.principalContactId, role: 'ceo', channel: 'web' },
    {
      humanApproved: true,
      sendResolution: pins ?? undefined,
      conversationId: row.conversationId ?? undefined,
      taskEventId: row.taskId,
    },
  );

  try {
    await deps.actionLogRepo.insert({
      taskId: row.taskId,
      conversationId: row.conversationId ?? undefined,
      toolName: row.toolName,
      actionRisk: row.actionRisk,
      outcome: reResult.success ? 'success' : 'failure',
      taskSummary: reResult.success ? undefined : reResult.error,
      parentActionId: row.id,
    });
  } catch (err) {
    deps.logger.error({ err, rowId: row.id }, 'console-approval: failed to insert child action_log row');
  }

  await publishDecision(deps, row, 'approve');
  deps.logger.info({ rowId: row.id, sent: reResult.success }, 'console-approval: approved');
  return { ok: true, sent: reResult.success };
}

/**
 * Discard a pending row. The blocked tool is not run. A linked mailbox draft is deleted first;
 * if that delete fails the row stays pending so the principal can retry.
 */
export async function denyFromConsole(
  row: ActionLogRow,
  deps: ConsoleApprovalDeps,
  now: Date = new Date(),
): Promise<ApprovalOutcome> {
  const blocked = stillPending(row, now);
  if (blocked) return blocked;

  const draft = mailboxDraftRef(row.toolName, row.payload);
  if (draft) {
    if (!deps.deleteMailboxDraft) {
      return { ok: false, status: 503, error: 'The mailbox draft could not be deleted.' };
    }
    try {
      await deps.deleteMailboxDraft(draft.account, draft.draftId);
    } catch (err) {
      deps.logger.error({ err, rowId: row.id, draftId: draft.draftId }, 'console-approval: draft delete failed — row left pending');
      return { ok: false, status: 502, error: 'The mailbox draft could not be deleted.' };
    }
  }

  const transitioned = await deps.actionLogRepo.resolveRow(row.id, 'denied', RESOLVED_BY.console);
  if (!transitioned) {
    return { ok: false, status: 409, error: 'That item is no longer waiting.' };
  }

  await rememberDisclosure(deps, row, 'no');
  await publishDecision(deps, row, 'deny');
  deps.logger.info({ rowId: row.id, draftDeleted: draft !== null }, 'console-approval: denied');
  return { ok: true, sent: false };
}
