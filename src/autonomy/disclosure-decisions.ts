// disclosure-decisions.ts — the principal's yes or no on a PII ask, remembered per thread (#2312).
//
// When band review holds a send because a requester asked for the principal's data (an "ask"),
// the gateway stores the ask beside the approval row (autonomy_action_log.disclosure_ask, never
// inside the replayed skill payload). Approving that row records `yes` for each (counterparty,
// label) of the ask; denying it records `no`. Dismissing or expiry records nothing.
//
// Band review reads the latest decision back for the send's conversation and recipients: a yes
// authorizes exactly that label to that counterparty on that thread, nothing broader, and a no
// turns a later ask there into a bounce. Rows hold labels and recipient identifiers only, never
// the values that were shared.

import type { DbPool } from '../db/connection.js';
import type { TaskOutreachRepo } from '../dispatch/task-outreach.js';
import type { Logger } from '../logger.js';

export type DisclosureDecision = 'yes' | 'no';

/**
 * The ask a held send carries, stored on its approval row. `counterparties` are the send's
 * non-principal recipients and `requester` the primary one, all normalized. `outreachId` is the
 * outreach row the drafting turn was linked to, when the link covered the recipients: a yes
 * learns the requester onto it.
 */
export interface DisclosureAsk {
  conversationId: string;
  counterparties: string[];
  labels: string[];
  requester: string;
  outreachId?: string;
}

export interface DisclosureDecisionRow {
  counterparty: string;
  label: string;
  decision: DisclosureDecision;
}

/** A recipient identifier as decisions are keyed: the last `<addr>` of a display-name form, trimmed and lowercased. */
export function normalizeCounterparty(id: string): string {
  const angle = /<([^<>]+)>\s*$/.exec(id);
  return (angle ? angle[1]! : id).trim().toLowerCase();
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function nonEmptyStrings(v: unknown): string[] | null {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString) ? v : null;
}

/**
 * The stored ask, checked rather than trusted (it arrives as JSONB). Anything malformed is no
 * ask: the approval still replays, it just records no decision.
 */
export function readDisclosureAsk(raw: unknown): DisclosureAsk | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { conversationId, counterparties, labels, requester, outreachId } = raw as Record<string, unknown>;
  const cps = nonEmptyStrings(counterparties);
  const ls = nonEmptyStrings(labels);
  if (!isNonEmptyString(conversationId) || !cps || !ls || !isNonEmptyString(requester)) return null;
  if (outreachId !== undefined && !isNonEmptyString(outreachId)) return null;
  return {
    conversationId,
    counterparties: [...new Set(cps.map(normalizeCounterparty))],
    labels: [...new Set(ls)],
    requester: normalizeCounterparty(requester),
    ...(outreachId !== undefined ? { outreachId } : {}),
  };
}

export class DisclosureDecisionsRepo {
  constructor(private readonly pool: DbPool) {}

  /** Record decisions, one row each. The decider is always the principal. */
  async record(rows: ReadonlyArray<{
    conversationId: string; counterparty: string; label: string; decision: DisclosureDecision; actionRef?: string;
  }>): Promise<void> {
    if (rows.length === 0) return;
    await this.pool.query(
      `INSERT INTO disclosure_decisions (conversation_id, counterparty, label, decision, decided_by, action_ref)
       SELECT c, p, l, d, 'principal', r
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS t(c, p, l, d, r)`,
      [
        rows.map((r) => r.conversationId),
        rows.map((r) => normalizeCounterparty(r.counterparty)),
        rows.map((r) => r.label),
        rows.map((r) => r.decision),
        rows.map((r) => r.actionRef ?? null),
      ],
    );
  }

  /** The latest decision per (counterparty, label) on this conversation, for these counterparties only. */
  async latestFor(conversationId: string, counterparties: readonly string[]): Promise<DisclosureDecisionRow[]> {
    const who = [...new Set(counterparties.map(normalizeCounterparty))];
    if (who.length === 0) return [];
    const result = await this.pool.query(
      `SELECT DISTINCT ON (counterparty, label) counterparty, label, decision
         FROM disclosure_decisions
        WHERE conversation_id = $1 AND counterparty = ANY($2::text[])
        ORDER BY counterparty, label, created_at DESC, id DESC`,
      [conversationId, who],
    );
    return result.rows
      .filter((r: Record<string, unknown>) => r.decision === 'yes' || r.decision === 'no')
      .map((r: Record<string, unknown>) => ({
        counterparty: r.counterparty as string,
        label: r.label as string,
        decision: r.decision as DisclosureDecision,
      }));
  }
}

/**
 * Records the principal's answer to an approval that carried an ask: the approve and deny
 * paths (approve-action, deny-action, reaction approvals) call it after the row transitioned.
 * Never throws: the decision is already the row's outcome, and an approved send still replays.
 */
export class DisclosureDecisionRecorder {
  constructor(private readonly deps: {
    repo: Pick<DisclosureDecisionsRepo, 'record'>;
    /** For a yes on a linked thread: the requester is learned onto the outreach row (PR 4's rule). */
    taskOutreachRepo?: Pick<TaskOutreachRepo, 'learnCounterparty'>;
    logger: Logger;
  }) {}

  async recordForApproval(
    row: { id: number; shortRef: string | null; disclosureAsk?: DisclosureAsk | null },
    decision: DisclosureDecision,
  ): Promise<void> {
    const ask = row.disclosureAsk;
    if (!ask) return;
    const rows = ask.counterparties.flatMap((counterparty) => ask.labels.map((label) => ({
      conversationId: ask.conversationId, counterparty, label, decision,
      ...(row.shortRef ? { actionRef: row.shortRef } : {}),
    })));
    try {
      await this.deps.repo.record(rows);
      this.deps.logger.info(
        { rowId: row.id, conversationId: ask.conversationId, labels: ask.labels, counterparties: ask.counterparties.length, decision },
        'disclosure-decisions: recorded the principal\'s answer to a personal-data ask',
      );
    } catch (err) {
      // A lost yes asks again next time; a lost no may ask again. Neither shares anything.
      this.deps.logger.error(
        { err, rowId: row.id, conversationId: ask.conversationId, labels: ask.labels, decision },
        'disclosure-decisions: could not record the principal\'s answer — the thread may be asked again',
      );
    }
    if (decision !== 'yes' || !ask.outreachId) return;
    if (!this.deps.taskOutreachRepo) {
      this.deps.logger.warn({ rowId: row.id, outreachId: ask.outreachId }, 'disclosure-decisions: outreach repo not wired — the requester is not learned onto the linked row');
      return;
    }
    try {
      await this.deps.taskOutreachRepo.learnCounterparty(ask.outreachId, { address: ask.requester });
    } catch (err) {
      this.deps.logger.error({ err, rowId: row.id, outreachId: ask.outreachId }, 'disclosure-decisions: could not learn the requester onto the linked outreach row');
    }
  }
}
