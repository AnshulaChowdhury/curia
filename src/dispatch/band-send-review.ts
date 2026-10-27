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
// Detected personal data (#2312): `disclosure` is added to the questions, and the judge rules
// each item directed / inferred / unsupported and whether the recipient asked. Code decides
// who had the authority to direct it, from trusted state (never the judge's word):
//   principal — the drafting turn's originator, or the bound or root task's, is the principal
//   trusted   — the originator was stamped trusted, is trusted now, and authenticated
//   directed  + principal → send          directed + trusted → send, copy the principal
//   inferred  + principal → send at 80+, hold below
//   anything else is unsupported: requested by a known/trusted recipient → hold (ask the
//   principal); otherwise bounce, then block/hold like any finding. More than 10 items, or a
//   judge failure with items present, is never a fail-open send. A `[REDACTED: …]`
//   placeholder in the content bounces the same way. The strictest outcome of all the rules
//   wins: block > hold > bounce > send.
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
import type {
  BriefAnswers, BriefDetectedItem, BriefQuestion, BriefVerdict, DisclosureRuling, SendAuthority,
} from '../autonomy/judge-brief.js';
import type { ContactTier } from '../contacts/types.js';
import { isSpotCheckOrAbove, type FailOpenLimiter } from '../autonomy/band-policy.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { FilterFinding } from './outbound-filter.js';

const BOUNCE_TTL_MS = 30 * 60_000;
const ALL_QUESTIONS: readonly BriefQuestion[] = ['purpose', 'speaks-as-principal', 'grounding', 'necessity'];
/** The most detected items the judge rules on in one call; past it, none are asked about (#2312). */
const MAX_REVIEWED_ITEMS = 10;
/** A placeholder the tier redactor writes. Under band gating it is a defect, never delivered. */
const REDACTION_TOKEN = /\[REDACTED: [A-Z0-9_]+\]/;
const TOO_MANY_DETAIL = 'This message contains more personal details than can be reviewed at once. Send fewer, or split the message.';
const TOKEN_DETAIL = 'This message contains a redaction placeholder. Rewrite it with the real content or without that part.';
const UNREVIEWED_BELOW_80_REASON = 'Held for the principal: the reviewer was unavailable, and this band asks first when it is.';

/** What the drafter is told when a send is blocked; the gateway appends the findings. */
export const BLOCK_REASON = 'Not sent: after one rewrite it still has the problems below. Rewrite it again without them, or tell the principal.';

export const BAND_RULES = {
  ungrounded: 'ungrounded-claim',
  unneeded: 'unneeded-disclosure',
  steered: 'steered',
  speaksAsPrincipal: 'speaks-as-principal',
  unreviewed: 'review-unavailable',
  pii: 'pii-not-authorized',
  token: 'redaction-token',
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
  /** The personal data detected in the send (#2312); each item needs an authorized ruling to go out. */
  detectedItems?: readonly BriefDetectedItem[];
  /** The primary recipient's tier: a known or trusted requester can be asked about (#2312). */
  recipientTier?: ContactTier;
  /** The subject line, when the channel has one: scanned for redaction placeholders like the content. */
  subject?: string;
}

export type BandReviewReport = { source: 'sent_without_review'; summary: string };

/**
 * What the review learned about a send it let through, for the spot-check pool (#2159
 * Phase 3): the gateway records them on the pool row so riskier sends are sampled more.
 */
export type BandReviewSignals = { speaksAsPrincipal?: boolean; bounced?: boolean };

export type BandReviewDecision =
  // copyPrincipal: a trusted contact directed these items out; the principal is copied (#2312).
  | { kind: 'send'; report?: BandReviewReport; signals?: BandReviewSignals; copyPrincipal?: { labels: string[] } }
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
  /** A contact's current tier (#2312). Null, or a throw, is no trusted authority. */
  contactTier: (contactId: string) => Promise<ContactTier | null>;
  logger: Logger;
  now?: () => number;
}

export class BandSendReview {
  /** `rules`: what the draft bounced or was blocked for, so a recheck hold can say so. */
  private readonly bounced = new Map<string, LedgerEntry>();
  private readonly now: () => number;

  constructor(private readonly deps: BandSendReviewDeps) {
    this.now = deps.now ?? Date.now;
  }

  async review(input: BandReviewInput): Promise<BandReviewDecision> {
    const key = this.draftKey(input);
    const prior = this.priorBounce(key);
    const taskIds = [...new Set([...(prior?.taskEventIds ?? []), ...(input.taskEventId ? [input.taskEventId] : [])])];

    const items = input.detectedItems ?? [];
    // Past the cap the judge is not asked about the items at all: they are all unsupported.
    const askedItems = items.length > 0 && items.length <= MAX_REVIEWED_ITEMS ? items : undefined;
    const questions: readonly BriefQuestion[] = askedItems ? [...this.questionsFor(input), 'disclosure'] : this.questionsFor(input);
    const hasToken = REDACTION_TOKEN.test(input.content) || (input.subject !== undefined && REDACTION_TOKEN.test(input.subject));

    const asked = await this.ask(input, questions, taskIds, input.content, askedItems);
    let verdict = asked.verdict;
    if (verdict.ok && askedItems && !rulesOnEach(verdict.disclosures, askedItems)) {
      // The parser already refuses this; checked again because a gap here would read as a pass.
      this.deps.logger.error({ conversationId: input.conversationId, items: askedItems.length, rulings: verdict.disclosures?.length ?? 0 }, 'band review: verdict does not rule on every detected item — treating as a reviewer failure');
      verdict = { ok: false, failure: 'malformed' };
    }

    if (!verdict.ok) {
      if (items.length === 0 && !hasToken) {
        this.bounced.delete(key);
        if (prior) {
          // This draft already bounced on a finding the drafter has not shown resolved.
          // Failing open now would send exactly what the review flagged, so hold instead.
          this.deps.logger.warn({ conversationId: input.conversationId, failure: verdict.failure }, 'band review: reviewer unavailable on the recheck of a bounced draft — holding');
          return this.hold(BAND_RULES.unreviewed, recheckReason(prior.rules));
        }
        return this.onJudgeFailure(input, verdict.failure);
      }
      // Personal data or a placeholder never goes out unreviewed: no fail-open send, and the
      // fail-open allowance is not spent on it.
      this.deps.logger.warn({ conversationId: input.conversationId, channel: input.channel, failure: verdict.failure, items: items.length, token: hasToken }, 'band review: reviewer unavailable with personal data or a placeholder in the send — not failing open');
      const other = prior
        ? this.hold(BAND_RULES.unreviewed, recheckReason(prior.rules))
        : !isSpotCheckOrAbove(input.score)
          ? this.unreviewedBelow80Hold(items, hasToken)
          : undefined;
      const pii = this.unreviewedPiiOutcome(input, items, hasToken, prior !== undefined);
      // PII first, so its reason leads a merged hold: the bounce may have been for the items.
      return this.settle(key, taskIds, input, prior !== undefined, other ? combine(pii, other) : pii);
    }
    this.deps.limiter.recordJudgeSuccess();

    const other = this.otherRulesOutcome(input, verdict, items, prior !== undefined);
    const pii = await this.piiOutcome(input, items, askedItems ? verdict.disclosures ?? [] : undefined, asked.authority, hasToken, prior !== undefined);
    return this.settle(key, taskIds, input, prior !== undefined, combine(other, pii));
  }

  /** The band rules other than disclosure, as before #2312. Writes nothing to the ledger. */
  private otherRulesOutcome(
    input: BandReviewInput,
    verdict: BriefAnswers,
    detected: readonly BriefDetectedItem[],
    hasPrior: boolean,
  ): BandReviewDecision {
    if (verdict.purpose === 'steered') {
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel }, 'band review: held — steered by an outsider');
      return this.hold(BAND_RULES.steered, 'Held for the principal: the reviewer judged this send to be steered by someone outside the principal\'s business.');
    }
    if (verdict.speaksAsPrincipal === true && !isSpotCheckOrAbove(input.score)) {
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel, score: input.score }, 'band review: held — speaks for the principal below 80');
      return this.hold(BAND_RULES.speaksAsPrincipal, 'Held for the principal: this message speaks for or commits the principal, and the autonomy band asks first for that.');
    }

    const claims = verdict.unsupportedClaims ?? [];
    // Detected items are ruled under disclosure only (#2312): an unneeded-disclosure quote that
    // overlaps one is dropped, or an authorized item would bounce here anyway.
    const unneeded = (verdict.unnecessaryItems ?? []).filter((q) => !detected.some((d) => overlaps(q, d.text)));
    if (claims.length === 0 && unneeded.length === 0) {
      return { kind: 'send', signals: { ...(verdict.speaksAsPrincipal === true ? { speaksAsPrincipal: true } : {}), ...(hasPrior ? { bounced: true } : {}) } };
    }

    if (!hasPrior) {
      this.deps.logger.info(
        { conversationId: input.conversationId, channel: input.channel, claims: claims.length, items: unneeded.length },
        'band review: bounced to the drafter',
      );
      return { kind: 'bounce', findings: this.bounceFindings(input.content, claims, unneeded, detected) };
    }

    // The one bounce is spent. Below 80 the principal decides; at 80+ the message is not sent.
    if (!isSpotCheckOrAbove(input.score)) {
      return this.hold(BAND_RULES.ungrounded, 'Held for the principal: it still states things about the principal that nothing looked up supports.');
    }
    this.deps.logger.info(
      { conversationId: input.conversationId, channel: input.channel, claims: claims.length, items: unneeded.length, outcome: 'blocked' },
      'band review: blocked — findings survived the rewrite',
    );
    return { kind: 'block', reason: BLOCK_REASON, findings: this.bounceFindings(input.content, claims, unneeded, detected) };
  }

  /**
   * The disclosure policy (#2312). The judge says why each item is there; code decides whether
   * anyone with the authority to share it directed the work, so a ruling of `directed` counts
   * only for an authority the evidence shows. `rulings` is undefined when the judge was not
   * asked (more items than it reviews at once): every item is then unsupported.
   */
  private async piiOutcome(
    input: BandReviewInput,
    items: readonly BriefDetectedItem[],
    rulings: readonly DisclosureRuling[] | undefined,
    authority: SendAuthority | undefined,
    hasToken: boolean,
    hasPrior: boolean,
  ): Promise<BandReviewDecision> {
    const askable = input.recipientTier === 'known' || input.recipientTier === 'trusted';
    const toRewrite: FilterFinding[] = [];
    const holds: FilterFinding[] = [];
    const copy = new Set<string>();

    if (items.length > 0 && rulings === undefined) {
      toRewrite.push({ rule: BAND_RULES.pii, detail: TOO_MANY_DETAIL });
    } else if (items.length > 0) {
      const byId = new Map(rulings!.map((r) => [r.id, r]));
      const who = await this.authorityOf(authority, rulings!);
      const unsupported = new Set<string>();
      const askFirst = new Set<string>();
      const inferredBelow80 = new Set<string>();
      const taskDirectedBelow80 = new Set<string>();
      for (const item of items) {
        // rulesOnEach() guaranteed one ruling per item.
        const r = byId.get(item.id)!;
        if (r.basis === 'directed' && who === 'principal') continue;
        if (r.basis === 'directed' && who === 'trusted') { copy.add(item.label); continue; }
        // The principal set the task, but this turn is not theirs: a directed ruling counts
        // only as inferred, since the principal did not direct this send themselves.
        if (r.basis === 'directed' && who === 'principal-task') {
          if (!isSpotCheckOrAbove(input.score)) taskDirectedBelow80.add(item.label);
          continue;
        }
        if (r.basis === 'inferred' && (who === 'principal' || who === 'principal-task')) {
          if (!isSpotCheckOrAbove(input.score)) inferredBelow80.add(item.label);
          continue;
        }
        // Every other combination is unsupported.
        if (r.requested && askable) askFirst.add(item.label);
        else unsupported.add(item.label);
      }
      if (unsupported.size > 0) {
        toRewrite.push({
          rule: BAND_RULES.pii,
          detail: `This message shares personal details nothing authorizes for this recipient: ${[...unsupported].join(', ')}. Rewrite it without them${askable ? ', or ask the principal' : ''}.`,
        });
      }
      if (inferredBelow80.size > 0) {
        holds.push({ rule: BAND_RULES.pii, detail: `Held for the principal: it shares personal details (${[...inferredBelow80].join(', ')}) that the principal's request needs but did not name, and this band asks first.` });
      }
      if (taskDirectedBelow80.size > 0) {
        holds.push({ rule: BAND_RULES.pii, detail: `Held for the principal: it shares personal details (${[...taskDirectedBelow80].join(', ')}) for a task the principal set, not at their request in this conversation, and this band asks first.` });
      }
      if (askFirst.size > 0) {
        holds.push({ rule: BAND_RULES.pii, detail: `Held for the principal: the recipient asked for personal details (${[...askFirst].join(', ')}) that nothing authorizes sharing yet.` });
      }
      // Ids, labels and counts only: the judge's reasons and the items' text can echo the data.
      this.deps.logger.info(
        {
          conversationId: input.conversationId, channel: input.channel, items: items.length, authority: who,
          unsupported: [...unsupported], askFirst: [...askFirst], inferredBelow80: [...inferredBelow80], taskDirectedBelow80: [...taskDirectedBelow80], copyPrincipal: [...copy],
        },
        'band review: disclosure rulings applied',
      );
    }
    if (hasToken) toRewrite.push({ rule: BAND_RULES.token, detail: TOKEN_DETAIL });

    if (toRewrite.length > 0) return this.rewriteOutcome(input, toRewrite, hasPrior);
    if (holds.length > 0) return { kind: 'hold', reason: holds[0]!.detail, findings: holds };
    return { kind: 'send', ...(copy.size > 0 ? { copyPrincipal: { labels: [...copy] } } : {}) };
  }

  /** The judge failed with items or a placeholder present: nothing is authorized. */
  private unreviewedPiiOutcome(input: BandReviewInput, items: readonly BriefDetectedItem[], hasToken: boolean, hasPrior: boolean): BandReviewDecision {
    const labels = [...new Set(items.map((i) => i.label))].join(', ');
    const decisions: BandReviewDecision[] = [];
    if (items.length > 0) {
      decisions.push(hasPrior
        ? this.hold(BAND_RULES.pii, `Held for the principal: it shares personal details (${labels}), and the reviewer was unavailable to check them.`)
        : {
          kind: 'bounce',
          findings: [{
            rule: BAND_RULES.pii,
            detail: items.length > MAX_REVIEWED_ITEMS
              ? TOO_MANY_DETAIL
              : `The reviewer could not check the personal details in this message: ${labels}. Rewrite it without them.`,
          }],
        });
    }
    if (hasToken) decisions.push(this.rewriteOutcome(input, [{ rule: BAND_RULES.token, detail: TOKEN_DETAIL }], hasPrior));
    return decisions.reduce(combine);
  }

  /** The reviewer is down below 80: hold, naming (by label) the personal data the send carries. */
  private unreviewedBelow80Hold(items: readonly BriefDetectedItem[], hasToken: boolean): BandReviewDecision {
    const findings: FilterFinding[] = [{ rule: BAND_RULES.unreviewed, detail: UNREVIEWED_BELOW_80_REASON }];
    if (items.length > 0) {
      findings.push({ rule: BAND_RULES.pii, detail: `It contains personal details the reviewer could not check: ${[...new Set(items.map((i) => i.label))].join(', ')}.` });
    }
    if (hasToken) findings.push({ rule: BAND_RULES.token, detail: TOKEN_DETAIL });
    return { kind: 'hold', reason: UNREVIEWED_BELOW_80_REASON, findings };
  }

  /** Findings the drafter must rewrite away: bounce once, then block at 80+ or hold below. */
  private rewriteOutcome(input: BandReviewInput, findings: FilterFinding[], hasPrior: boolean): BandReviewDecision {
    if (!hasPrior) return { kind: 'bounce', findings };
    if (isSpotCheckOrAbove(input.score)) return { kind: 'block', reason: BLOCK_REASON, findings };
    return {
      kind: 'hold',
      reason: 'Held for the principal: after one rewrite it still has personal details nothing authorizes, or a redaction placeholder.',
      findings,
    };
  }

  /**
   * Who directed the work, from trusted state only. The principal: their own turn (a live turn,
   * or a wake they originated). The principal's task: only the bound or root task is theirs,
   * not the drafting turn, so a directed ruling counts as inferred. A trusted contact: their
   * stamped tier and their tier now are both trusted, and their message authenticated them.
   * Anything else, or a failed tier read, is no authority.
   */
  private async authorityOf(a: SendAuthority | undefined, rulings: readonly DisclosureRuling[]): Promise<'principal' | 'principal-task' | 'trusted' | 'none'> {
    if (!a) return 'none';
    // `liveTurn` is context for the judge only. Code trusts the stamped role: stampOriginator
    // sets systemRole 'principal' only from the resolved sender, and a wake carries the
    // originator its job was created with.
    if (a.originator?.systemRole === 'principal') return 'principal';
    if ([a.boundTask?.originator, a.rootTask?.originator].some((o) => o?.systemRole === 'principal')) return 'principal-task';
    const o = a.originator;
    // Only a directed ruling uses trusted authority, so skip the lookup otherwise.
    if (!o || o.tier !== 'trusted' || o.authenticated !== true || !rulings.some((r) => r.basis === 'directed')) return 'none';
    try {
      return (await this.deps.contactTier(o.contactId)) === 'trusted' ? 'trusted' : 'none';
    } catch (err) {
      this.deps.logger.error({ err, contactId: o.contactId }, 'band review: could not read the originator\'s current tier — no trusted authority');
      return 'none';
    }
  }

  /** Record the final outcome in the one-bounce ledger and return it. */
  private settle(key: string, taskIds: string[], input: BandReviewInput, hasPrior: boolean, decision: BandReviewDecision): BandReviewDecision {
    if (decision.kind === 'bounce' || decision.kind === 'block') {
      // A block keeps the entry and refreshes its time: the drafter's next attempt is still a
      // recheck, and a clean one clears it.
      this.bounced.set(key, { taskEventIds: taskIds, at: this.now(), rules: decision.findings.map((f) => f.rule) });
      return decision;
    }
    this.bounced.delete(key);
    if (decision.kind === 'send' && hasPrior) {
      // Metric (spec "Measuring success"): a bounce resolved by the drafter looking it up.
      this.deps.logger.info({ conversationId: input.conversationId, outcome: 'resolved_by_lookup' }, 'band review: bounced send passed on recheck');
    }
    return decision;
  }

  private questionsFor(input: BandReviewInput): readonly BriefQuestion[] {
    return input.principalDirected ? ['grounding'] : ALL_QUESTIONS;
  }

  private async ask(
    input: BandReviewInput,
    questions: readonly BriefQuestion[],
    taskIds: string[],
    message: string,
    detectedItems: readonly BriefDetectedItem[] | undefined,
  ): Promise<{ verdict: BriefVerdict; authority?: SendAuthority }> {
    if (!this.deps.judge?.isEnabled()) return { verdict: { ok: false, failure: 'disabled' } };
    const evidence = await this.deps.evidence.collect(taskIds);
    // Without evidence every claim looks unsupported; that is a review failure, not a bounce.
    if (evidence.unavailable) return { verdict: { ok: false, failure: 'unreachable' } };
    // Newest first, so the note leads. The relay's principal note is not under the drafting
    // task in audit_log (its parent is the agent.response), so it arrives with the send
    // rather than from the collector.
    const reportsToPrincipal = input.reportedToPrincipal
      ? [reportEvidence(input.reportedToPrincipal), ...(evidence.reportsToPrincipal ?? [])]
      : evidence.reportsToPrincipal;
    const verdict = await this.deps.judge.review({
      questions,
      message,
      recipients: input.recipients,
      ...(input.principalRecipients ? { principalRecipients: input.principalRecipients } : {}),
      ...(detectedItems ? { detectedItems } : {}),
      band: AutonomyService.bandForScore(input.score),
      evidence: { ...evidence, ...(reportsToPrincipal ? { reportsToPrincipal } : {}) },
      conversationId: input.conversationId ?? 'system',
    });
    return { verdict, authority: evidence.authority };
  }

  private async onJudgeFailure(input: BandReviewInput, failure: string): Promise<BandReviewDecision> {
    if (!isSpotCheckOrAbove(input.score)) {
      this.deps.logger.warn({ failure, channel: input.channel, score: input.score }, 'band review: reviewer unavailable — holding (below 80)');
      return this.hold(BAND_RULES.unreviewed, UNREVIEWED_BELOW_80_REASON);
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
  private bounceFindings(content: string, claims: string[], items: string[], detected: readonly BriefDetectedItem[]): FilterFinding[] {
    // A quote holding a detected item's value is never shown: findings carry labels, not values.
    const inMessage = (quotes: string[]) => quotes
      .map((q) => q.trim())
      .filter((q) => q.length > 0 && content.includes(q) && !detected.some((d) => containsFolded(q, d.text)));
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

  private priorBounce(key: string): LedgerEntry | undefined {
    const entry = this.bounced.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > BOUNCE_TTL_MS) {
      this.bounced.delete(key);
      return undefined;
    }
    return entry;
  }
}

const STRICTNESS: Record<BandReviewDecision['kind'], number> = { send: 0, bounce: 1, hold: 2, block: 3 };

/**
 * The strictest of two outcomes: block > hold > bounce > send. Equal outcomes merge, so the
 * drafter or the principal sees every rule that fired; the first one's reason leads.
 */
function combine(a: BandReviewDecision, b: BandReviewDecision): BandReviewDecision {
  if (STRICTNESS[a.kind] !== STRICTNESS[b.kind]) return STRICTNESS[a.kind] > STRICTNESS[b.kind] ? a : b;
  if (a.kind === 'send' && b.kind === 'send') {
    const report = a.report ?? b.report;
    const signals = a.signals || b.signals ? { ...a.signals, ...b.signals } : undefined;
    const labels = [...new Set([...(a.copyPrincipal?.labels ?? []), ...(b.copyPrincipal?.labels ?? [])])];
    return {
      kind: 'send',
      ...(report ? { report } : {}),
      ...(signals ? { signals } : {}),
      ...(labels.length > 0 ? { copyPrincipal: { labels } } : {}),
    };
  }
  if (a.kind === 'bounce' && b.kind === 'bounce') return { kind: 'bounce', findings: [...a.findings, ...b.findings] };
  if (a.kind === 'block' && b.kind === 'block') return { kind: 'block', reason: a.reason, findings: [...a.findings, ...b.findings] };
  if (a.kind === 'hold' && b.kind === 'hold') return { kind: 'hold', reason: a.reason, findings: [...a.findings, ...b.findings] };
  return a;
}

/** Exactly one ruling for each asked item. */
function rulesOnEach(rulings: readonly DisclosureRuling[] | undefined, items: readonly BriefDetectedItem[]): boolean {
  if (rulings === undefined || rulings.length !== items.length) return false;
  const ids = new Set(rulings.map((r) => r.id));
  return ids.size === items.length && items.every((i) => ids.has(i.id));
}

type LedgerEntry = { taskEventIds: string[]; at: number; rules: string[] };

/** The recheck hold's reason, naming what the draft was flagged for. */
function recheckReason(rules: readonly string[]): string {
  const flagged: string[] = [];
  if (rules.includes(BAND_RULES.ungrounded) || rules.includes(BAND_RULES.unneeded)) flagged.push('unverified statements');
  if (rules.includes(BAND_RULES.pii)) flagged.push('personal details');
  if (rules.includes(BAND_RULES.token)) flagged.push('a redaction placeholder');
  return `Held for the principal: it was flagged for ${flagged.length > 0 ? flagged.join(' and ') : 'unverified statements'}, and the reviewer was unavailable to recheck it.`;
}

function containsFolded(haystack: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return n.length > 0 && haystack.toLowerCase().includes(n);
}

/** Either text contains the other, ignoring case. */
function overlaps(a: string, b: string): boolean {
  return containsFolded(a, b) || containsFolded(b, a);
}
