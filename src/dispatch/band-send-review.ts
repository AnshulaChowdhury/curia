// band-send-review.ts — the gateway's review of an outbound send under band gating (#2159).
//
// Runs after the content filter's integrity rules and Stage 2 pass, only when
// `autonomy.gating: band`. It replaces Stage 2.5's tier × disclosure table: the escalation
// judge answers the brief (judge-brief.ts) using what the drafting turn actually looked up,
// and code decides what each answer does at the current band.
//
// Which questions are asked:
//   principal-directed (a live principal turn)  → grounding
//   otherwise, at every band                    → all four (Gate C leaves sends to this review)
//
// What each answer does:
//   purpose = steered                → hold, at every band
//   speaks as principal, below 80    → hold (the band asks first)
//   unsupported claims / unneeded    → bounce to the drafter, ONCE per draft. Curia never
//     disclosures                       cuts text out of a message: the drafter rewrites it.
//                                       If the rewrite still has findings, at 80+ the send is
//                                       refused back to the drafter (not sent, told to rewrite
//                                       again or tell the principal); below 80, held. The
//                                       gateway holds instead of refusing when no drafter is
//                                       waiting: a relayed reply or a saved draft.
//   judge failure                    → 80+: send with a "sent without review" item, capped
//                                       at 5 an hour (then hold until a judge call succeeds);
//                                       below 80: hold.
//
// The bounce ledger is in memory, keyed by conversation, channel and recipients, so a relay
// rewrite (a new task on the same conversation) counts as the recheck and sees the first
// turn's lookups. A restart between a bounce and its recheck gives one more bounce. The two
// post-bounce fates treat the entry differently: a block (80+) keeps it, so the drafter's next
// dirty attempt blocks again; a hold (below 80) clears it, because the principal now decides
// and a later draft on the same key starts a fresh cycle with its own bounce.

import type { Logger } from '../logger.js';
import type { EscalationJudge } from '../autonomy/escalation-judge.js';
import { reportEvidence, type SendEvidenceCollector } from '../autonomy/send-evidence.js';
import type { BriefQuestion, BriefVerdict } from '../autonomy/judge-brief.js';
import { isSpotCheckOrAbove, type FailOpenLimiter } from '../autonomy/band-policy.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { FilterFinding } from './outbound-filter.js';

const BOUNCE_TTL_MS = 30 * 60_000;
const ALL_QUESTIONS: readonly BriefQuestion[] = ['purpose', 'speaks-as-principal', 'grounding', 'necessity'];

/** What the drafter is told when a send is blocked; the gateway appends the findings. */
export const BLOCK_REASON = 'Not sent: after one rewrite it still has the problems below. Rewrite it again without them, or tell the principal.';

export const BAND_RULES = {
  ungrounded: 'ungrounded-claim',
  unneeded: 'unneeded-disclosure',
  steered: 'steered',
  speaksAsPrincipal: 'speaks-as-principal',
  unreviewed: 'review-unavailable',
} as const;

export interface BandReviewInput {
  content: string;
  channel: string;
  recipients: readonly string[];
  /** The subset of `recipients` that are the principal; the judge never treats content to them as a disclosure. */
  principalRecipients?: readonly string[];
  score: number;
  conversationId?: string;
  taskEventId?: string;
  /** A live principal turn told Curia to send this: only grounding is asked. */
  principalDirected: boolean;
  /** A dispatcher-relayed reply. Asked the same questions as any send; kept for the logs. */
  postTurn: boolean;
  /** The note the dispatcher cut from this relayed reply and queued for the principal (#2312); evidence that Curia told them. */
  reportedToPrincipal?: string;
}

export type BandReviewReport = { source: 'sent_without_review'; summary: string };

/**
 * What the review learned about a send it let through, for the spot-check pool (#2159
 * Phase 3): the gateway records them on the pool row so riskier sends are sampled more.
 */
export type BandReviewSignals = { speaksAsPrincipal?: boolean; bounced?: boolean };

export type BandReviewDecision =
  | { kind: 'send'; report?: BandReviewReport; signals?: BandReviewSignals }
  | { kind: 'bounce'; findings: FilterFinding[] }
  // Not sent, and not held for the principal: the drafter must rewrite it again (80+ only). The gateway converts it to a hold for a relayed reply or a saved draft.
  | { kind: 'block'; reason: string; findings: FilterFinding[] }
  | { kind: 'hold'; reason: string; findings: FilterFinding[] };

export interface BandSendReviewDeps {
  judge: Pick<EscalationJudge, 'review' | 'isEnabled'> | undefined;
  evidence: Pick<SendEvidenceCollector, 'collect'>;
  limiter: FailOpenLimiter;
  /** Called once when the fail-open cap trips. Must not throw. */
  onLimiterTripped: () => Promise<void>;
  logger: Logger;
  now?: () => number;
}

export class BandSendReview {
  private readonly bounced = new Map<string, { taskEventIds: string[]; at: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: BandSendReviewDeps) {
    this.now = deps.now ?? Date.now;
  }

  async review(input: BandReviewInput): Promise<BandReviewDecision> {
    const key = this.draftKey(input);
    const prior = this.priorBounce(key);
    const taskIds = [...new Set([...(prior?.taskEventIds ?? []), ...(input.taskEventId ? [input.taskEventId] : [])])];

    const verdict = await this.ask(input, this.questionsFor(input), taskIds, input.content);
    if (!verdict.ok) {
      this.bounced.delete(key);
      if (prior) {
        // This draft already bounced on a finding the drafter has not shown resolved.
        // Failing open now would send exactly what the review flagged, so hold instead.
        this.deps.logger.warn({ conversationId: input.conversationId, failure: verdict.failure }, 'band review: reviewer unavailable on the recheck of a bounced draft — holding');
        return this.hold(BAND_RULES.unreviewed, 'Held for the principal: it was flagged for unverified statements, and the reviewer was unavailable to recheck it.');
      }
      return this.onJudgeFailure(input, verdict.failure);
    }
    this.deps.limiter.recordJudgeSuccess();

    if (verdict.purpose === 'steered') {
      this.bounced.delete(key);
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel, reason: verdict.reason }, 'band review: held — steered by an outsider');
      return this.hold(BAND_RULES.steered, 'Held for the principal: the reviewer judged this send to be steered by someone outside the principal\'s business.');
    }
    if (verdict.speaksAsPrincipal === true && !isSpotCheckOrAbove(input.score)) {
      this.bounced.delete(key);
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel, score: input.score }, 'band review: held — speaks for the principal below 80');
      return this.hold(BAND_RULES.speaksAsPrincipal, 'Held for the principal: this message speaks for or commits the principal, and the autonomy band asks first for that.');
    }

    const claims = verdict.unsupportedClaims ?? [];
    const items = verdict.unnecessaryItems ?? [];
    if (claims.length === 0 && items.length === 0) {
      if (prior) {
        // Metric (spec "Measuring success"): a bounce resolved by the drafter looking it up.
        this.deps.logger.info({ conversationId: input.conversationId, outcome: 'resolved_by_lookup' }, 'band review: bounced send passed on recheck');
      }
      this.bounced.delete(key);
      return { kind: 'send', signals: { ...(verdict.speaksAsPrincipal === true ? { speaksAsPrincipal: true } : {}), ...(prior ? { bounced: true } : {}) } };
    }

    if (!prior) {
      this.bounced.set(key, { taskEventIds: taskIds, at: this.now() });
      this.deps.logger.info(
        { conversationId: input.conversationId, channel: input.channel, claims: claims.length, items: items.length },
        'band review: bounced to the drafter',
      );
      return { kind: 'bounce', findings: this.bounceFindings(input.content, claims, items) };
    }

    // The one bounce is spent. Below 80 the principal decides; at 80+ the message is not sent.
    if (!isSpotCheckOrAbove(input.score)) {
      this.bounced.delete(key);
      return this.hold(BAND_RULES.ungrounded, 'Held for the principal: it still states things about the principal that nothing looked up supports.');
    }
    // Keep the entry and refresh its time: the drafter's next attempt is still a recheck, and
    // a clean one clears it.
    this.bounced.set(key, { taskEventIds: taskIds, at: this.now() });
    this.deps.logger.info(
      { conversationId: input.conversationId, channel: input.channel, claims: claims.length, items: items.length, outcome: 'blocked' },
      'band review: blocked — findings survived the rewrite',
    );
    return { kind: 'block', reason: BLOCK_REASON, findings: this.bounceFindings(input.content, claims, items) };
  }

  private questionsFor(input: BandReviewInput): readonly BriefQuestion[] {
    return input.principalDirected ? ['grounding'] : ALL_QUESTIONS;
  }

  private async ask(
    input: BandReviewInput,
    questions: readonly BriefQuestion[],
    taskIds: string[],
    message: string,
  ): Promise<BriefVerdict> {
    if (!this.deps.judge?.isEnabled()) return { ok: false, failure: 'disabled' };
    const evidence = await this.deps.evidence.collect(taskIds);
    // Without evidence every claim looks unsupported; that is a review failure, not a bounce.
    if (evidence.unavailable) return { ok: false, failure: 'unreachable' };
    // Newest first, so the note leads. The relay's principal note is not under the drafting
    // task in audit_log (its parent is the agent.response), so it arrives with the send
    // rather than from the collector.
    const reportsToPrincipal = input.reportedToPrincipal
      ? [reportEvidence(input.reportedToPrincipal), ...(evidence.reportsToPrincipal ?? [])]
      : evidence.reportsToPrincipal;
    return this.deps.judge.review({
      questions,
      message,
      recipients: input.recipients,
      ...(input.principalRecipients ? { principalRecipients: input.principalRecipients } : {}),
      band: AutonomyService.bandForScore(input.score),
      evidence: { ...evidence, ...(reportsToPrincipal ? { reportsToPrincipal } : {}) },
      conversationId: input.conversationId ?? 'system',
    });
  }

  private async onJudgeFailure(input: BandReviewInput, failure: string): Promise<BandReviewDecision> {
    if (!isSpotCheckOrAbove(input.score)) {
      this.deps.logger.warn({ failure, channel: input.channel, score: input.score }, 'band review: reviewer unavailable — holding (below 80)');
      return this.hold(BAND_RULES.unreviewed, 'Held for the principal: the reviewer was unavailable, and this band asks first when it is.');
    }
    const { allowed, justTripped } = this.deps.limiter.tryAcquire();
    if (justTripped) {
      this.deps.logger.error({ failure }, 'band review: more than 5 unreviewed sends this hour — holding sends until the reviewer answers');
      await this.deps.onLimiterTripped();
    }
    if (!allowed) {
      this.deps.logger.warn({ failure, channel: input.channel }, 'band review: reviewer unavailable and the fail-open cap is tripped — holding');
      return this.hold(BAND_RULES.unreviewed, 'Held for the principal: the reviewer has been unavailable for several sends in a row.');
    }
    this.deps.logger.warn({ failure, channel: input.channel }, 'band review: reviewer unavailable — sending without review (80+)');
    return {
      kind: 'send',
      report: {
        source: 'sent_without_review',
        summary: `Sent a ${input.channel} message to ${input.recipients.join(', ')} without the usual review: the reviewer was unavailable.`,
      },
    };
  }

  private hold(rule: string, reason: string): BandReviewDecision {
    return { kind: 'hold', reason, findings: [{ rule, detail: reason }] };
  }

  /**
   * The drafter is shown only quotes that are verbatim in its own message. Anything else the
   * judge wrote (a paraphrase, or text echoed from the evidence) is left out, so a bounce
   * never carries text the message did not already contain. With no verbatim quote left the
   * finding still stands, in general terms: the judge did flag something.
   */
  private bounceFindings(content: string, claims: string[], items: string[]): FilterFinding[] {
    const inMessage = (quotes: string[]) => quotes.map((q) => q.trim()).filter((q) => q.length > 0 && content.includes(q));
    const findings: FilterFinding[] = [];
    if (claims.length > 0) {
      const shown = inMessage(claims);
      findings.push({
        rule: BAND_RULES.ungrounded,
        detail: shown.length > 0
          ? `These claims about the principal are not backed by anything you looked up this turn: ${shown.map((c) => `"${c}"`).join('; ')}. Verify them with your tools or remove them.`
          : 'Some statements about the principal are not backed by anything you looked up this turn. Verify them with your tools or remove them.',
      });
    }
    if (items.length > 0) {
      const shown = inMessage(items);
      findings.push({
        rule: BAND_RULES.unneeded,
        detail: shown.length > 0
          ? `This message shares details its purpose does not need: ${shown.map((c) => `"${c}"`).join('; ')}. Remove them unless the recipient needs them.`
          : 'This message shares details its purpose does not need. Remove them unless the recipient needs them.',
      });
    }
    return findings;
  }

  private draftKey(input: BandReviewInput): string {
    const who = [...input.recipients].map((r) => r.toLowerCase()).sort().join(',');
    return `${input.conversationId ?? input.taskEventId ?? ''}|${input.channel}|${who}`;
  }

  private priorBounce(key: string): { taskEventIds: string[]; at: number } | undefined {
    const entry = this.bounced.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > BOUNCE_TTL_MS) {
      this.bounced.delete(key);
      return undefined;
    }
    return entry;
  }
}
