// band-send-review.test.ts — the gateway's review of a send under band gating (#2159).

import { describe, expect, it, vi } from 'vitest';
import * as bandReviewModule from '../../../src/dispatch/band-send-review.js';
import { BandSendReview, BLOCK_REASON, type BandReviewDecision, type BandReviewInput } from '../../../src/dispatch/band-send-review.js';
import { FailOpenLimiter } from '../../../src/autonomy/band-policy.js';
import type { BriefDetectedItem, BriefVerdict, DisclosureRuling, SendAuthority } from '../../../src/autonomy/judge-brief.js';
import type { ContactTier } from '../../../src/contacts/types.js';
import { createSilentLogger } from '../../../src/logger.js';

const OK_EVIDENCE = { unavailable: false, toolResults: [], principalBlock: null };

function make(
  verdicts: BriefVerdict[],
  opts: { evidence?: { unavailable?: boolean; authority?: SendAuthority }; contactTier?: (id: string) => Promise<ContactTier | null> } = {},
) {
  const review = vi.fn();
  for (const v of verdicts) review.mockResolvedValueOnce(v);
  const judge = { review, isEnabled: () => true };
  const collect = vi.fn().mockResolvedValue({ ...OK_EVIDENCE, ...opts.evidence });
  const onLimiterTripped = vi.fn().mockResolvedValue(undefined);
  const limiter = new FailOpenLimiter();
  const contactTier = vi.fn(opts.contactTier ?? (async () => null));
  const svc = new BandSendReview({ judge, evidence: { collect }, limiter, onLimiterTripped, contactTier, logger: createSilentLogger() });
  return { svc, review, collect, onLimiterTripped, limiter, contactTier };
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
      limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createSilentLogger(), now: () => t,
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
    const { svc, review, collect } = make([clean, clean, clean, clean]);
    collect.mockResolvedValue({ ...OK_EVIDENCE, reportsToPrincipal: ['Earlier note.'] });

    await svc.review({ ...base, reportedToPrincipal: 'Provider asked for your number.' });
    expect(review.mock.calls[0]![0].evidence.reportsToPrincipal).toEqual(['Provider asked for your number.', 'Earlier note.']);

    // Redacted and clipped like the collector's evidence.
    await svc.review({ ...base, conversationId: 'conv-3', reportedToPrincipal: `key sk-ant-abcdefghijklmnopqrstuvwxyz0123 ${'x'.repeat(5000)}` });
    const [leading] = review.mock.calls[1]![0].evidence.reportsToPrincipal as string[];
    expect(leading).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(leading).toContain('[REDACTED]');
    expect(leading!.length).toBeLessThanOrEqual(2_001);

    // Without a note the collected reports pass through untouched.
    await svc.review({ ...base, conversationId: 'conv-2' });
    expect(review.mock.calls[2]![0].evidence.reportsToPrincipal).toEqual(['Earlier note.']);
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
      limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createSilentLogger(),
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

  // Authority-aware PII (#2312): the judge rules on each detected item; code decides who
  // has the authority and what each ruling does.
  describe('detected personal data', () => {
    const SIN = '046 454 286';
    const content = `Hi Joel. Sam's SIN is ${SIN}.`;
    const P1: BriefDetectedItem = { id: 'P1', label: 'sin_ca', text: SIN, field: 'body' };
    const P2: BriefDetectedItem = { id: 'P2', label: 'phone_us', text: '415-555-0100', field: 'body' };
    const pii: BandReviewInput = { ...base, content, detectedItems: [P1] };

    type Originator = NonNullable<SendAuthority['originator']>;
    const principal: Originator = { contactId: 'c-principal', systemRole: 'principal', tier: 'principal', channel: 'signal', authenticated: true };
    const curia: Originator = { contactId: 'c-curia', systemRole: 'agent', tier: null, channel: 'internal', authenticated: false };
    const outsider: Originator = { contactId: 'x@evil.example', systemRole: null, tier: 'unknown', channel: 'email', authenticated: false };
    const trusted: Originator = { contactId: 'c-trusted', systemRole: null, tier: 'trusted', channel: 'email', authenticated: true };

    const live: SendAuthority = { originator: principal, liveTurn: true };
    const standing: SendAuthority = {
      originator: curia, liveTurn: false,
      boundTask: { taskId: 't-child', title: 'Book the call', description: null, originator: curia },
      rootTask: { taskId: 't-root', title: 'Set up the clinic', description: null, originator: principal },
    };
    const fromOutsider: SendAuthority = { originator: outsider, liveTurn: false };
    const fromTrusted: SendAuthority = { originator: trusted, liveTurn: false };

    const ruling = (basis: DisclosureRuling['basis'], requested = false, id = 'P1'): DisclosureRuling => ({ id, basis, requested, reason: `ruled on ${SIN}` });
    type OkVerdict = Extract<BriefVerdict, { ok: true }>;
    const withRulings = (...disclosures: DisclosureRuling[]): OkVerdict => ({ ...(clean as OkVerdict), disclosures });
    const directedOnly = (...disclosures: DisclosureRuling[]): BriefVerdict => ({ ok: true, unsupportedClaims: [], disclosures, reason: 'ok' });

    it('sends a principal-directed item, asking disclosure alongside grounding with the items', async () => {
      const { svc, review } = make([directedOnly(ruling('directed'))], { evidence: { authority: live } });
      await expect(svc.review({ ...pii, principalDirected: true })).resolves.toEqual({ kind: 'send', signals: {} });
      expect(review.mock.calls[0]![0].questions).toEqual(['grounding', 'disclosure']);
      expect(review.mock.calls[0]![0].detectedItems).toEqual([P1]);
    });

    it('asks disclosure after the other four when the send is not principal-directed', async () => {
      const { svc, review } = make([withRulings(ruling('directed'))], { evidence: { authority: live } });
      await svc.review(pii);
      expect(review.mock.calls[0]![0].questions).toEqual(['purpose', 'speaks-as-principal', 'grounding', 'necessity', 'disclosure']);
    });

    it('does not ask disclosure, or pass items, when nothing was detected', async () => {
      for (const detectedItems of [undefined, []]) {
        const { svc, review } = make([clean]);
        await svc.review({ ...base, detectedItems });
        expect(review.mock.calls[0]![0].questions).not.toContain('disclosure');
        expect(review.mock.calls[0]![0].detectedItems).toBeUndefined();
      }
    });

    it('sends an inferred item under a standing task whose root the principal created at 84, and holds it at 74', async () => {
      const at84 = make([withRulings(ruling('inferred'))], { evidence: { authority: standing } });
      expect((await at84.svc.review(pii)).kind).toBe('send');
      const at74 = make([withRulings(ruling('inferred'))], { evidence: { authority: standing } });
      const d = await at74.svc.review({ ...pii, score: 74 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
    });

    it('counts the bound task\'s principal originator as principal authority', async () => {
      const bound: SendAuthority = { originator: curia, liveTurn: false, boundTask: { taskId: 't', title: 'x', description: null, originator: principal } };
      const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority: bound } });
      expect((await svc.review(pii)).kind).toBe('send');
    });

    // Narrow authority (#2312): the principal set the task, but the drafting turn is not theirs,
    // so a directed ruling counts as inferred: sent at 80+, held below.
    it('treats a directed ruling as inferred when only the bound or root task is the principal\'s', async () => {
      const bound: SendAuthority = { originator: curia, liveTurn: false, boundTask: { taskId: 't', title: 'x', description: null, originator: principal } };
      for (const authority of [bound, standing]) {
        const at84 = make([withRulings(ruling('directed'))], { evidence: { authority } });
        expect((await at84.svc.review(pii)).kind).toBe('send');
        const at74 = make([withRulings(ruling('directed'))], { evidence: { authority } });
        const d = await at74.svc.review({ ...pii, score: 74 });
        expect(d.kind).toBe('hold');
        if (d.kind === 'hold') {
          expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
          expect(d.reason).toContain('sin_ca');
          expect(d.reason).toContain('a task the principal set');
          expect(d.reason).not.toContain(SIN);
        }
      }
    });

    it('keeps a full directed ruling at 74 for a live principal turn or a wake the principal originated', async () => {
      const wake: SendAuthority = {
        originator: principal, liveTurn: false,
        boundTask: { taskId: 't', title: 'x', description: null, originator: curia },
      };
      for (const authority of [live, wake]) {
        const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority } });
        expect((await svc.review({ ...pii, score: 74 })).kind).toBe('send');
      }
    });

    // A reply linked to outreach (#2312): the sender is the outsider who replied; the link says
    // which task their message answers. Only a strong link to the principal's task is authority.
    describe('a reply linked to the outreach of a task', () => {
      type Linked = NonNullable<SendAuthority['linkedTask']>;
      const link = (strength: Linked['strength'], originator: SendAuthority['originator'] = principal): SendAuthority => ({
        originator: outsider, liveTurn: false,
        linkedTask: { taskId: 't-link', title: 'Book physio', originator, linkKind: strength === 'strong' ? 'org-domain' : 'inferred', strength },
      });

      it('gives a strong link to the principal\'s task principal-task authority: inferred sends at 84, holds at 74', async () => {
        for (const basis of ['inferred', 'directed'] as const) {
          const at84 = make([withRulings(ruling(basis, true))], { evidence: { authority: link('strong') } });
          expect((await at84.svc.review(pii)).kind).toBe('send');
          const at74 = make([withRulings(ruling(basis, true))], { evidence: { authority: link('strong') } });
          const d = await at74.svc.review({ ...pii, score: 74 });
          expect(d.kind).toBe('hold');
          if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        }
      });

      it('gives a task-less strong link the principal directed the same authority', async () => {
        const authority: SendAuthority = { ...link('strong'), linkedTask: { ...link('strong').linkedTask!, taskId: null, title: null } };
        const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority } });
        expect((await svc.review(pii)).kind).toBe('send');
      });

      it('gives a weak link no authority, but makes a requesting recipient askable: held at 84 and 74', async () => {
        for (const score of [84, 74]) {
          const { svc } = make([withRulings(ruling('inferred', true))], { evidence: { authority: link('weak') } });
          const d = await svc.review({ ...pii, score });
          expect(d.kind).toBe('hold');
          if (d.kind === 'hold') {
            expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
            expect(d.reason).toContain('the recipient asked');
            expect(d.reason).not.toContain(SIN);
          }
        }
      });

      it('bounces a weak link\'s item the recipient did not ask for, offering to ask the principal', async () => {
        const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: link('weak') } });
        const d = await svc.review(pii);
        expect(d.kind).toBe('bounce');
        if (d.kind === 'bounce') {
          expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
          expect(d.findings[0]!.detail).toContain('ask the principal');
        }
      });

      it('gives a link to a task the principal did not direct no authority and no askability', async () => {
        for (const originator of [curia, outsider, null]) {
          for (const strength of ['strong', 'weak'] as const) {
            const { svc } = make([withRulings(ruling('inferred', true))], { evidence: { authority: link(strength, originator) } });
            const d = await svc.review(pii);
            expect(d.kind).toBe('bounce');
            if (d.kind === 'bounce') expect(d.findings[0]!.detail).not.toContain('ask the principal');
          }
        }
      });
    });

    it('bounces an item the judge called directed when an outsider originated the work, naming only the label', async () => {
      const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority: fromOutsider } });
      const d = await svc.review(pii);
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') {
        expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        expect(d.findings[0]!.detail).toContain('sin_ca');
        expect(d.findings[0]!.detail).not.toContain(SIN);
        expect(d.findings[0]!.detail).not.toContain('ask the principal');
      }
    });

    it('bounces when the evidence carries no authority at all', async () => {
      const { svc } = make([withRulings(ruling('directed'))]);
      expect((await svc.review(pii)).kind).toBe('bounce');
    });

    it('sends a trusted contact\'s directed item at 74 and copies the principal', async () => {
      const { svc, contactTier } = make([withRulings(ruling('directed'))], {
        evidence: { authority: fromTrusted }, contactTier: async () => 'trusted',
      });
      await expect(svc.review({ ...pii, score: 74 })).resolves.toEqual({ kind: 'send', signals: {}, copyPrincipal: { labels: ['sin_ca'] } });
      expect(contactTier).toHaveBeenCalledWith('c-trusted');
    });

    it('lists each copied label once', async () => {
      const P3: BriefDetectedItem = { ...P1, id: 'P3', text: '046 454 287' };
      const { svc } = make([withRulings(ruling('directed'), ruling('directed', false, 'P3'))], {
        evidence: { authority: fromTrusted }, contactTier: async () => 'trusted',
      });
      const d = await svc.review({ ...pii, detectedItems: [P1, P3] });
      expect(d).toMatchObject({ kind: 'send', copyPrincipal: { labels: ['sin_ca'] } });
    });

    it('gives no trusted authority to a contact demoted since, or whose tier cannot be read', async () => {
      for (const contactTier of [async () => 'known' as const, async () => null, async () => { throw new Error('db down'); }]) {
        const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority: fromTrusted }, contactTier });
        expect((await svc.review(pii)).kind).toBe('bounce');
      }
    });

    it('gives no trusted authority when the originating message was not authenticated', async () => {
      const { svc, contactTier } = make([withRulings(ruling('directed'))], {
        evidence: { authority: { originator: { ...trusted, authenticated: false }, liveTurn: false } }, contactTier: async () => 'trusted',
      });
      expect((await svc.review(pii)).kind).toBe('bounce');
      expect(contactTier).not.toHaveBeenCalled();
    });

    it('does not let a trusted contact unlock an inferred item', async () => {
      const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: fromTrusted }, contactTier: async () => 'trusted' });
      expect((await svc.review(pii)).kind).toBe('bounce');
    });

    it('holds an unsupported item a known recipient asked for, and bounces it for an unknown one', async () => {
      const known = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
      const held = await known.svc.review({ ...pii, recipientTier: 'known' });
      expect(held.kind).toBe('hold');
      if (held.kind === 'hold') expect(held.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);

      const unknown = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
      expect((await unknown.svc.review({ ...pii, recipientTier: 'unknown' })).kind).toBe('bounce');
    });

    it('bounces an unrequested item to an askable recipient, offering to ask the principal', async () => {
      const { svc } = make([withRulings(ruling('unsupported', false))], { evidence: { authority: fromOutsider } });
      const d = await svc.review({ ...pii, recipientTier: 'trusted' });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') expect(d.findings[0]!.detail).toContain('or ask the principal');
    });

    it('blocks a second draft that still has an unsupported item at 84, and holds it at 74', async () => {
      for (const [score, kind] of [[84, 'block'], [74, 'hold']] as const) {
        const { svc } = make([withRulings(ruling('unsupported')), withRulings(ruling('unsupported'))], { evidence: { authority: fromOutsider } });
        expect((await svc.review({ ...pii, score })).kind).toBe('bounce');
        const d = await svc.review({ ...pii, score });
        expect(d.kind).toBe(kind);
        if (d.kind === 'block') {
          expect(d.reason).toBe(BLOCK_REASON);
          expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        }
      }
    });

    it('sends the rewrite once the item is gone, reporting the bounce', async () => {
      const { svc } = make([withRulings(ruling('unsupported')), clean], { evidence: { authority: fromOutsider } });
      await svc.review(pii);
      await expect(svc.review({ ...base, content: 'Hi Joel.' })).resolves.toEqual({ kind: 'send', signals: { bounced: true } });
    });

    it('bounces on a judge failure with items present, never failing open, then holds the rewrite', async () => {
      const failure: BriefVerdict = { ok: false, failure: 'unreachable' };
      const { svc, onLimiterTripped } = make([failure, failure], { evidence: { authority: live } });
      const first = await svc.review(pii);
      expect(first.kind).toBe('bounce');
      if (first.kind === 'bounce') {
        expect(first.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        expect(first.findings[0]!.detail).toContain('sin_ca');
      }
      expect((await svc.review(pii)).kind).toBe('hold');
      expect(onLimiterTripped).not.toHaveBeenCalled();
    });

    it('does not spend the fail-open allowance on a send it bounced for its items', async () => {
      const failure: BriefVerdict = { ok: false, failure: 'malformed' };
      const { svc } = make(Array(11).fill(failure));
      for (let i = 0; i < 6; i++) expect((await svc.review({ ...pii, conversationId: `p${i}` })).kind).toBe('bounce');
      // Five ordinary fail-opens are still available.
      for (let i = 0; i < 5; i++) expect((await svc.review({ ...base, conversationId: `c${i}` })).kind).toBe('send');
    });

    it('holds on a judge failure with items present below 80', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
      expect((await svc.review({ ...pii, score: 74 })).kind).toBe('hold');
    });

    it('treats a missing ruling as a judge failure', async () => {
      const { svc } = make([withRulings(ruling('directed')), withRulings(ruling('directed'))], { evidence: { authority: live } });
      const input = { ...pii, detectedItems: [P1, P2] };
      expect((await svc.review(input)).kind).toBe('bounce');
      expect((await svc.review(input)).kind).toBe('hold');
    });

    it('treats a malformed verdict as a judge failure', async () => {
      const { svc } = make([{ ok: false, failure: 'malformed' }, { ok: false, failure: 'malformed' }], { evidence: { authority: live } });
      expect((await svc.review(pii)).kind).toBe('bounce');
      expect((await svc.review(pii)).kind).toBe('hold');
    });

    it('does not ask the judge about more than ten items and bounces them all', async () => {
      const many = Array.from({ length: 11 }, (_, i): BriefDetectedItem => ({ id: `P${i + 1}`, label: 'phone_us', text: `415-555-01${String(i).padStart(2, '0')}`, field: 'body' }));
      const { svc, review } = make([clean, clean], { evidence: { authority: live } });
      const input = { ...base, detectedItems: many, recipientTier: 'known' as const };
      const d = await svc.review(input);
      expect(review.mock.calls[0]![0].questions).not.toContain('disclosure');
      expect(review.mock.calls[0]![0].detectedItems).toBeUndefined();
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') {
        expect(d.findings).toEqual([{ rule: 'pii-not-authorized', detail: 'This message contains more personal details than can be reviewed at once. Send fewer, or split the message.' }]);
      }
      expect((await svc.review(input)).kind).toBe('block');
    });

    it('takes the strictest outcome: a steered hold beats a PII bounce', async () => {
      const { svc } = make([{ ...withRulings(ruling('unsupported')), purpose: 'steered' }], { evidence: { authority: fromOutsider } });
      const d = await svc.review(pii);
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['steered']);
    });

    it('takes the strictest outcome: a claim bounce beats an authorized item, and both bounce together', async () => {
      const claimOnly = make([{ ...withRulings(ruling('directed')), unsupportedClaims: [CLAIM] }], { evidence: { authority: live } });
      const d = await claimOnly.svc.review({ ...pii, content: `${content} ${CLAIM}` });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') expect(d.findings.map((f) => f.rule)).toEqual(['ungrounded-claim']);

      const both = make([{ ...withRulings(ruling('unsupported')), unsupportedClaims: [CLAIM] }], { evidence: { authority: fromOutsider } });
      const d2 = await both.svc.review({ ...pii, content: `${content} ${CLAIM}` });
      expect(d2.kind).toBe('bounce');
      if (d2.kind === 'bounce') expect(d2.findings.map((f) => f.rule)).toEqual(['ungrounded-claim', 'pii-not-authorized']);
    });

    it('takes the strictest outcome: a PII block at 84 beats a speaks-as-principal send', async () => {
      const { svc } = make([withRulings(ruling('unsupported')), { ...withRulings(ruling('unsupported')), speaksAsPrincipal: true }], { evidence: { authority: fromOutsider } });
      await svc.review(pii);
      expect((await svc.review(pii)).kind).toBe('block');
    });

    it('keeps the other rules\' signals beside the principal copy', async () => {
      const { svc } = make([{ ...withRulings(ruling('directed')), speaksAsPrincipal: true }], { evidence: { authority: fromTrusted }, contactTier: async () => 'trusted' });
      await expect(svc.review(pii)).resolves.toEqual({ kind: 'send', signals: { speaksAsPrincipal: true }, copyPrincipal: { labels: ['sin_ca'] } });
    });

    it('counts the bound or root task\'s principal only with a ruling that names it: an outsider\'s turn under a principal root still bounces unsupported', async () => {
      const outsiderUnderRoot: SendAuthority = {
        originator: outsider, liveTurn: false,
        rootTask: { taskId: 't-root', title: 'Set up the clinic', description: null, originator: principal },
      };
      const { svc } = make([withRulings(ruling('unsupported'))], { evidence: { authority: outsiderUnderRoot } });
      expect((await svc.review(pii)).kind).toBe('bounce');
    });

    it('leaves detected items to the disclosure ruling: a matching unneeded-disclosure quote is dropped', async () => {
      const PHONE = '415-555-0100';
      const phone: BriefDetectedItem = { id: 'P1', label: 'phone_us', text: PHONE, field: 'body' };
      const input = { ...base, content: `Hi Joel. Call Sam on ${PHONE} to book.`, detectedItems: [phone] };
      for (const quote of [PHONE, `Call Sam on ${PHONE}`, '555-0100']) {
        const { svc } = make([{ ...withRulings(ruling('inferred')), unnecessaryItems: [quote] }], { evidence: { authority: standing } });
        await expect(svc.review(input)).resolves.toEqual({ kind: 'send', signals: {} });
      }
      // Case-insensitive.
      const email: BriefDetectedItem = { id: 'P1', label: 'email', text: 'sam@example.com', field: 'body' };
      const { svc } = make([{ ...withRulings(ruling('inferred')), unnecessaryItems: ['Sam@Example.com'] }], { evidence: { authority: standing } });
      expect((await svc.review({ ...base, content: 'Hi Joel. Write to Sam@Example.com.', detectedItems: [email] })).kind).toBe('send');
    });

    it('keeps an unneeded-disclosure finding that does not touch a detected item', async () => {
      const { svc } = make([{ ...withRulings(ruling('inferred')), unnecessaryItems: ['His salary is 200k.'] }], { evidence: { authority: standing } });
      const d = await svc.review({ ...pii, content: `${content} His salary is 200k.` });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') expect(d.findings.map((f) => f.rule)).toEqual(['unneeded-disclosure']);
    });

    it('never quotes a detected item\'s text in any finding or reason', async () => {
      const text = `${content} His salary is 200k.`;
      const flagged: BriefVerdict = {
        ...withRulings(ruling('unsupported')),
        unsupportedClaims: [`Sam's SIN is ${SIN}.`],
        unnecessaryItems: ['His salary is 200k.', `SIN is ${SIN}. His salary`],
      };
      const decisions: BandReviewDecision[] = [];
      for (const score of [84, 74]) {
        const { svc } = make([flagged, flagged], { evidence: { authority: fromOutsider } });
        decisions.push(await svc.review({ ...pii, content: text, score }));
        decisions.push(await svc.review({ ...pii, content: text, score }));
      }
      for (const score of [84, 74]) {
        const failing = make([{ ok: false, failure: 'unreachable' }, { ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
        decisions.push(await failing.svc.review({ ...pii, score }));
        decisions.push(await failing.svc.review({ ...pii, score }));
      }
      const asked = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
      decisions.push(await asked.svc.review({ ...pii, recipientTier: 'known' }));
      expect(decisions.map((d) => d.kind)).toEqual(['bounce', 'block', 'bounce', 'hold', 'bounce', 'hold', 'hold', 'hold', 'hold']);
      for (const d of decisions) expect(JSON.stringify(d)).not.toContain(SIN);
      // The claim still stands, in general terms.
      const first = decisions[0]!;
      if (first.kind === 'bounce') expect(first.findings.map((f) => f.rule)).toEqual(['ungrounded-claim', 'unneeded-disclosure', 'pii-not-authorized']);
    });

    it('holds a recheck that fails again after a PII-failure bounce, naming personal details', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }, { ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
      expect((await svc.review(pii)).kind).toBe('bounce');
      // The rewrite dropped the item; the reviewer is still down.
      const d = await svc.review({ ...base, content: 'Hi Joel.' });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') {
        expect(d.reason).toContain('personal details');
        expect(d.reason).not.toContain('unverified statements');
      }
    });

    it('keeps the unverified-statements reason for a recheck after a claim bounce', async () => {
      const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ok: false, failure: 'unreachable' }]);
      await svc.review(base);
      const d = await svc.review(base);
      if (d.kind === 'hold') expect(d.reason).toContain('unverified statements');
      expect(d.kind).toBe('hold');
    });

    it('names the personal data, by label, on a judge-failure hold below 80', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
      const d = await svc.review({ ...pii, score: 74 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') {
        const finding = d.findings.find((f) => f.rule === 'pii-not-authorized');
        expect(finding?.detail).toContain('sin_ca');
        expect(JSON.stringify(d)).not.toContain(SIN);
      }
    });

    it('treats a ruling list of the right length with a wrong id as malformed', async () => {
      const { svc } = make([withRulings(ruling('directed'), ruling('directed', false, 'P3')), withRulings(ruling('directed'), ruling('directed', false, 'P3'))], { evidence: { authority: live } });
      const input = { ...pii, detectedItems: [P1, P2] };
      expect((await svc.review(input)).kind).toBe('bounce');
      expect((await svc.review(input)).kind).toBe('hold');
    });
  });

  describe('redaction placeholders', () => {
    const DETAIL = 'This message contains a redaction placeholder. Rewrite it with the real content or without that part.';
    const tokened: BandReviewInput = { ...base, content: 'Hi Joel. Call Sam on [REDACTED: PHONE_US].' };

    it('bounces a placeholder, then blocks it at 84', async () => {
      const { svc } = make([clean, clean]);
      const first = await svc.review(tokened);
      expect(first).toEqual({ kind: 'bounce', findings: [{ rule: 'redaction-token', detail: DETAIL }] });
      const second = await svc.review(tokened);
      expect(second.kind).toBe('block');
      if (second.kind === 'block') expect(second.findings).toEqual([{ rule: 'redaction-token', detail: DETAIL }]);
    });

    it('holds the second placeholder at 74', async () => {
      const { svc } = make([clean, clean]);
      await svc.review({ ...tokened, score: 74 });
      expect((await svc.review({ ...tokened, score: 74 })).kind).toBe('hold');
    });

    it('bounces a placeholder even when the judge fails at 84', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }]);
      expect((await svc.review(tokened)).kind).toBe('bounce');
    });

    it('catches a placeholder in the subject alone', async () => {
      const { svc } = make([clean]);
      const d = await svc.review({ ...base, subject: 'Re: [REDACTED: EMAIL]' });
      expect(d).toEqual({ kind: 'bounce', findings: [{ rule: 'redaction-token', detail: DETAIL }] });
    });

    it('ignores bracketed text that is not a placeholder', async () => {
      const { svc } = make([clean]);
      expect((await svc.review({ ...base, content: 'Hi Joel. [REDACTED] and [redacted: x] are fine.' })).kind).toBe('send');
    });
  });
});
