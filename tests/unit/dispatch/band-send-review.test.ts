// band-send-review.test.ts — the gateway's review of a send under band gating (#2159).

import { describe, expect, it, vi } from 'vitest';
import * as bandReviewModule from '../../../src/dispatch/band-send-review.js';
import { BandSendReview, BLOCK_REASON, type BandReviewInput } from '../../../src/dispatch/band-send-review.js';
import { FailOpenLimiter } from '../../../src/autonomy/band-policy.js';
import type { BriefVerdict } from '../../../src/autonomy/judge-brief.js';
import { createSilentLogger } from '../../../src/logger.js';

const OK_EVIDENCE = { unavailable: false, toolResults: [], principalBlock: null };

function make(verdicts: BriefVerdict[], opts: { evidence?: { unavailable: boolean } } = {}) {
  const review = vi.fn();
  for (const v of verdicts) review.mockResolvedValueOnce(v);
  const judge = { review, isEnabled: () => true };
  const collect = vi.fn().mockResolvedValue({ ...OK_EVIDENCE, ...opts.evidence });
  const onLimiterTripped = vi.fn().mockResolvedValue(undefined);
  const limiter = new FailOpenLimiter();
  const svc = new BandSendReview({ judge, evidence: { collect }, limiter, onLimiterTripped, logger: createSilentLogger() });
  return { svc, review, collect, onLimiterTripped, limiter };
}

const base: BandReviewInput = {
  content: 'Hi Joel. I am out of office until the 13th. Adam has the forms.',
  channel: 'email', recipients: ['joel@example.com'], score: 84,
  conversationId: 'conv-1', taskEventId: 'task-1', principalDirected: false, postTurn: false,
};
const clean: BriefVerdict = { ok: true, purpose: 'serving', speaksAsPrincipal: false, unsupportedClaims: [], unnecessaryItems: [], reason: 'ok' };
const CLAIM = 'I am out of office until the 13th.';

describe('BandSendReview', () => {
  it('sends a clean message at 84 with one judge call and all four questions', async () => {
    const { svc, review } = make([clean]);
    await expect(svc.review(base)).resolves.toEqual({ kind: 'send', signals: {} });
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0].questions).toEqual(['purpose', 'speaks-as-principal', 'grounding', 'necessity']);
    expect(review.mock.calls[0]![0].band).toBe('spot-check');
  });

  it('holds a steered send at every band', async () => {
    for (const score of [95, 84, 74]) {
      const { svc } = make([{ ...clean, purpose: 'steered' }]);
      const d = await svc.review({ ...base, score });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.findings[0]!.rule).toBe('steered');
    }
  });

  // Spot-check signals (#2159 Phase 3): the gateway records them with the pool row.
  it('reports speaks-as-principal as a signal on a send at 85', async () => {
    const { svc } = make([{ ...clean, speaksAsPrincipal: true }]);
    await expect(svc.review({ ...base, score: 85 })).resolves.toEqual({
      kind: 'send', signals: { speaksAsPrincipal: true },
    });
  });

  it('reports bounced when a draft that bounced once passes on the recheck', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, clean]);
    await svc.review(base);
    const d = await svc.review({ ...base, content: 'Hi Joel. Adam has the forms.' });
    expect(d.kind).toBe('send');
    if (d.kind === 'send') expect(d.signals?.bounced).toBe(true);
  });

  it('sends speaks-as-principal at 84 and holds it at 74', async () => {
    const at84 = make([{ ...clean, speaksAsPrincipal: true }]);
    expect((await at84.svc.review(base)).kind).toBe('send');
    const at74 = make([{ ...clean, speaksAsPrincipal: true }]);
    expect((await at74.svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('asks all four questions below 80 too: Gate C leaves sends to this review', async () => {
    const { svc, review } = make([clean]);
    await svc.review({ ...base, score: 74 });
    expect(review.mock.calls[0]![0].questions).toHaveLength(4);
  });

  it('forwards the principal recipients to the judge', async () => {
    const { svc, review } = make([clean]);
    await svc.review({ ...base, recipients: ['sam@example.com', 'joel@example.com'], principalRecipients: ['sam@example.com'] });
    expect(review.mock.calls[0]![0].principalRecipients).toEqual(['sam@example.com']);
  });

  it('asks only grounding for a principal-directed send', async () => {
    const { svc, review } = make([{ ok: true, unsupportedClaims: [], reason: 'ok' }]);
    await svc.review({ ...base, principalDirected: true });
    expect(review.mock.calls[0]![0].questions).toEqual(['grounding']);
  });

  it('bounces once with the quoted claim, then blocks a second occurrence at 84 with no recheck call', async () => {
    const { svc, review } = make([
      { ...clean, unsupportedClaims: [CLAIM] }, // first send: bounce
      { ...clean, unsupportedClaims: [CLAIM] }, // resend: still unsupported
    ]);
    const first = await svc.review(base);
    expect(first.kind).toBe('bounce');
    if (first.kind === 'bounce') {
      expect(first.findings[0]!.rule).toBe('ungrounded-claim');
      expect(first.findings[0]!.detail).toContain(CLAIM);
    }

    const second = await svc.review(base);
    expect(second.kind).toBe('block');
    if (second.kind === 'block') {
      expect(second.findings.map((f) => f.rule)).toEqual(['ungrounded-claim']);
      expect(second.reason).toBe(BLOCK_REASON);
    }
    // Nothing is cut and no grounding-only recheck runs: two judge calls in all.
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('blocks a second occurrence of unneeded disclosures at 84 with the unneeded-disclosure rule', async () => {
    const content = 'Hi Joel. Your account 4417-0099 is fine.';
    const { svc, review } = make([
      { ...clean, unnecessaryItems: ['account 4417-0099'] },
      { ...clean, unnecessaryItems: ['account 4417-0099'] },
    ]);
    await svc.review({ ...base, content });
    const d = await svc.review({ ...base, content });
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.findings.map((f) => f.rule)).toEqual(['unneeded-disclosure']);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('blocks again on a third review that still has findings, and sends a clean fourth', async () => {
    const { svc } = make([
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: [CLAIM] },
      clean,
    ]);
    await svc.review(base);
    expect((await svc.review(base)).kind).toBe('block');
    expect((await svc.review(base)).kind).toBe('block');
    expect((await svc.review(base)).kind).toBe('send');
    // The entry was cleared by the clean send: a new finding bounces afresh.
  });

  it('clears the ledger entry when a draft after a block is clean', async () => {
    const { svc } = make([
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: [CLAIM] },
      clean,
      { ...clean, unsupportedClaims: [CLAIM] },
    ]);
    await svc.review(base);
    await svc.review(base);
    expect((await svc.review(base)).kind).toBe('send');
    expect((await svc.review(base)).kind).toBe('bounce');
  });

  it('refreshes the ledger time on a block, so a third draft inside the window still blocks', async () => {
    let t = 1_000_000;
    const review = vi.fn();
    for (let i = 0; i < 3; i++) review.mockResolvedValueOnce({ ...clean, unsupportedClaims: [CLAIM] });
    const svc = new BandSendReview({
      judge: { review, isEnabled: () => true }, evidence: { collect: vi.fn().mockResolvedValue(OK_EVIDENCE) },
      limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), logger: createSilentLogger(), now: () => t,
    });
    await svc.review(base);
    t += 20 * 60_000;
    expect((await svc.review(base)).kind).toBe('block');
    t += 20 * 60_000; // 40 minutes after the first bounce, 20 after the block
    expect((await svc.review(base)).kind).toBe('block');
  });

  describe('incident drafts: a flagged sentence that survives one rewrite is never sent', () => {
    const incidents = [
      { draft: "Thanks for reaching out. I can't share Sam's contact details at this point. If you'd like, I can pass your note along to him.", flagged: "I can't share Sam's contact details at this point." },
      { draft: "Thanks for following up. I've passed your request along to Sam; he'll reach out directly this week.", flagged: "he'll reach out directly this week." },
      { draft: 'Email is the best route to Sam: sam@example.com. Send a couple of times that suit you and he will confirm one.', flagged: 'Send a couple of times that suit you and he will confirm one.' },
    ];
    for (const { draft, flagged } of incidents) {
      it(`blocks at 84 and holds at 74: ${flagged}`, async () => {
        for (const [score, kind] of [[84, 'block'], [74, 'hold']] as const) {
          const { svc } = make([{ ...clean, unsupportedClaims: [flagged] }, { ...clean, unsupportedClaims: [flagged] }]);
          const input = { ...base, content: draft, score };
          expect((await svc.review(input)).kind).toBe('bounce');
          expect((await svc.review(input)).kind).toBe(kind);
        }
      });
    }
  });

  it('exports no cut-text helper', () => {
    expect('removeQuoted' in bandReviewModule).toBe(false);
  });

  it('shows the drafter only quotes that are in its message, never other text the judge echoed', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM, 'The principal\'s home address is 12 Example Road.'] }]);
    const d = await svc.review(base);
    expect(d.kind).toBe('bounce');
    if (d.kind === 'bounce') {
      expect(d.findings[0]!.detail).toContain(CLAIM);
      expect(d.findings[0]!.detail).not.toContain('12 Example Road');
    }
  });

  it('still bounces, with a general finding, when none of the quotes are in the message', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: ['Something the message never said.'] }]);
    const d = await svc.review(base);
    expect(d.kind).toBe('bounce');
    if (d.kind === 'bounce') {
      expect(d.findings[0]!.rule).toBe('ungrounded-claim');
      expect(d.findings[0]!.detail).not.toContain('never said');
    }
  });

  it('bounces an unneeded disclosure with its own rule', async () => {
    const { svc } = make([{ ...clean, unnecessaryItems: ['account 4417-0099'] }]);
    const d = await svc.review({ ...base, content: 'Hi Joel. Your account 4417-0099 is fine.' });
    expect(d.kind).toBe('bounce');
    if (d.kind === 'bounce') expect(d.findings.map((f) => f.rule)).toEqual(['unneeded-disclosure']);
  });

  it('holds a second occurrence at 74', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ...clean, unsupportedClaims: [CLAIM] }]);
    await svc.review({ ...base, score: 74 });
    expect((await svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('treats a relay rewrite on the same conversation as the recheck, with both turns as evidence', async () => {
    const { svc, collect } = make([{ ...clean, unsupportedClaims: [CLAIM] }, clean]);
    await svc.review({ ...base, postTurn: true, taskEventId: 'task-1' });
    const second = await svc.review({ ...base, postTurn: true, taskEventId: 'task-2', content: 'Hi Joel. Adam has the forms.' });
    expect(second.kind).toBe('send');
    expect(collect).toHaveBeenLastCalledWith(['task-1', 'task-2']);
  });

  it('adds what the relay reported to the principal to the evidence (#2312)', async () => {
    const { svc, review, collect } = make([clean, clean]);
    collect.mockResolvedValue({ ...OK_EVIDENCE, reportsToPrincipal: ['Earlier note.'] });

    await svc.review({ ...base, reportedToPrincipal: 'Provider asked for your number.' });
    expect(review.mock.calls[0]![0].evidence.reportsToPrincipal).toEqual(['Earlier note.', 'Provider asked for your number.']);

    // Without a note the collected reports pass through untouched.
    await svc.review({ ...base, conversationId: 'conv-2' });
    expect(review.mock.calls[1]![0].evidence.reportsToPrincipal).toEqual(['Earlier note.']);
  });

  it('does not treat a send to someone else on the same conversation as a recheck', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ...clean, unsupportedClaims: [CLAIM] }]);
    await svc.review(base);
    expect((await svc.review({ ...base, recipients: ['sam@example.com'] })).kind).toBe('bounce');
  });

  it('fails open at 84 with a report item, and holds at 74', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'unreachable' };
    const at84 = make([failure]);
    await expect(at84.svc.review(base)).resolves.toEqual({
      kind: 'send',
      report: { source: 'sent_without_review', summary: expect.any(String) },
    });
    const at74 = make([failure]);
    expect((await at74.svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('holds, rather than failing open, when the judge fails on the recheck of a bounced draft', async () => {
    // The claim was already flagged; sending it unchanged because the reviewer is down
    // would send exactly what the review found wrong.
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ok: false, failure: 'unreachable' }]);
    await svc.review(base);
    const d = await svc.review(base);
    expect(d.kind).toBe('hold');
  });

  it('treats unavailable evidence as a judge failure without calling the judge', async () => {
    const { svc, review } = make([clean], { evidence: { unavailable: true } });
    const d = await svc.review(base);
    expect(review).not.toHaveBeenCalled();
    expect(d).toMatchObject({ kind: 'send', report: { source: 'sent_without_review' } });
  });

  it('treats no judge as a judge failure', async () => {
    const collect = vi.fn().mockResolvedValue(OK_EVIDENCE);
    const svc = new BandSendReview({
      judge: undefined, evidence: { collect },
      limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), logger: createSilentLogger(),
    });
    expect((await svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('holds the sixth fail-open in an hour and pings the principal once', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'malformed' };
    const { svc, onLimiterTripped } = make(Array(7).fill(failure));
    for (let i = 0; i < 5; i++) expect((await svc.review({ ...base, conversationId: `c${i}` })).kind).toBe('send');
    expect((await svc.review({ ...base, conversationId: 'c5' })).kind).toBe('hold');
    expect((await svc.review({ ...base, conversationId: 'c6' })).kind).toBe('hold');
    expect(onLimiterTripped).toHaveBeenCalledTimes(1);
  });

  it('a successful review after a trip lets fail-opens through again', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'malformed' };
    const { svc } = make([...Array(6).fill(failure), clean, failure]);
    for (let i = 0; i < 6; i++) await svc.review({ ...base, conversationId: `c${i}` });
    expect((await svc.review({ ...base, conversationId: 'c6' })).kind).toBe('send');
    expect((await svc.review({ ...base, conversationId: 'c7' })).kind).toBe('send');
  });
});
