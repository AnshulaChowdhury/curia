// The checks over what a through-gateway run sent (#2312): delivered, not_delivered, held,
// outreach_recorded, decision_recorded. Each passes and fails on the recorded outcome alone.
import { describe, expect, it } from 'vitest';
import { emptyBreakdown } from '../../shared/usage.js';
import { evaluateCheck } from '../../scenarios/assertions.js';
import type { GatewayOutcome, RecordedDelivery, ScenarioRun } from '../../scenarios/types.js';

const ctx = { internalNames: [] as string[] };

function delivery(overrides: Partial<RecordedDelivery> = {}): RecordedDelivery {
  return {
    channel: 'email',
    kind: 'send',
    to: ['pat@vendor.example.test'],
    cc: [],
    toNames: ['pat'],
    ccNames: [],
    subject: 'Your quote',
    body: 'Thanks Pat, the account number ends 4421.',
    ...overrides,
  };
}

function run(gateway: Partial<GatewayOutcome> | undefined): ScenarioRun {
  return {
    runIndex: 0, inboundContent: 'hi', refs: {}, toolCalls: [], reply: 'ok', durationMs: 1, unstubbedCalls: 0,
    usage: emptyBreakdown(), providerRetries: [],
    ...(gateway ? { gateway: { deliveries: [], holds: [], outreach: [], decisions: [], reviewerFailedOpen: false, ...gateway } } : {}),
  };
}

describe('delivered', () => {
  const r = run({
    deliveries: [
      delivery(),
      delivery({ channel: 'signal', to: ['+15555550123'], toNames: ['principal'], subject: undefined, body: 'Approval 3: send Pat the quote?' }),
      delivery({ kind: 'draft', to: ['lee@vendor.example.test'], toNames: ['lee'] }),
    ],
  });

  it('passes on a delivery matching every filter', () => {
    expect(evaluateCheck({ kind: 'delivered', to: 'pat', contains: ['account number'] }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'delivered', channel: 'signal', to: 'principal' }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'delivered', to: 'PAT@vendor.example.test' }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'delivered', contains: ['your quote'] }, r, ctx).rating).toBe('PASS');
  });

  it('misses when no delivery matches', () => {
    expect(evaluateCheck({ kind: 'delivered', to: 'pat', excludes: ['4421'] }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'delivered', channel: 'sms' }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'delivered', to: 'pat', contains: ['SIN'] }, r, ctx).rating).toBe('MISS');
  });

  it('never repeats an excluded term in its justification', () => {
    const rating = evaluateCheck({ kind: 'delivered', to: 'pat', excludes: ['4421'] }, r, ctx);
    expect(rating.rating).toBe('MISS');
    expect(rating.justification).not.toContain('4421');
    expect(rating.justification).toContain('[excluded]');
  });

  it('does not count a draft as a delivery', () => {
    expect(evaluateCheck({ kind: 'delivered', to: 'lee' }, r, ctx).rating).toBe('MISS');
  });

  it('checks cc and an exact count', () => {
    const cc = run({ deliveries: [delivery({ cc: ['principal@example.test'], ccNames: ['principal'] }), delivery()] });
    expect(evaluateCheck({ kind: 'delivered', ccIncludes: 'principal' }, cc, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'delivered', to: 'pat', count: 2 }, cc, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'delivered', to: 'pat', count: 1 }, cc, ctx).rating).toBe('MISS');
  });

  it('misses a run that did not go through the gateway', () => {
    const rating = evaluateCheck({ kind: 'delivered' }, run(undefined), ctx);
    expect(rating.rating).toBe('MISS');
    expect(rating.justification).toContain('through_gateway');
  });
});

describe('not_delivered', () => {
  it('passes when nothing (or nothing to `to`) was delivered', () => {
    expect(evaluateCheck({ kind: 'not_delivered' }, run({}), ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'not_delivered', to: 'lee' }, run({ deliveries: [delivery()] }), ctx).rating).toBe('PASS');
    // A draft never left.
    expect(evaluateCheck({ kind: 'not_delivered' }, run({ deliveries: [delivery({ kind: 'draft' })] }), ctx).rating).toBe('PASS');
  });

  it('misses on a delivery', () => {
    expect(evaluateCheck({ kind: 'not_delivered' }, run({ deliveries: [delivery()] }), ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'not_delivered', to: 'pat' }, run({ deliveries: [delivery()] }), ctx).rating).toBe('MISS');
  });
});

describe('held', () => {
  const hold = {
    shortRef: 'a3f7c12b', approvalNumber: 3, toolName: 'email-send', outcome: 'pending_approval',
    description: 'Send Pat the quote', preamble: 'Pat asked for your SIN. Share it?', extraLines: ['Reason: personal data'],
  };

  it('passes on an approval raised this run, with what it shows', () => {
    expect(evaluateCheck({ kind: 'held' }, run({ holds: [hold] }), ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'held', contains: ['share it', 'personal data'] }, run({ holds: [hold] }), ctx).rating).toBe('PASS');
    // Resolved during the run still counts: it was held.
    expect(evaluateCheck({ kind: 'held' }, run({ holds: [{ ...hold, outcome: 'approved' }] }), ctx).rating).toBe('PASS');
  });

  it('misses with no approval, or one that does not show the text', () => {
    expect(evaluateCheck({ kind: 'held' }, run({}), ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'held', contains: ['passport'] }, run({ holds: [hold] }), ctx).rating).toBe('MISS');
  });
});

describe('outreach_recorded', () => {
  const row = { domains: ['vendor.example.test'], addresses: ['pat@vendor.example.test'], confirmed: true, via: 'email', seeded: false };

  it('passes on a matching row', () => {
    expect(evaluateCheck({ kind: 'outreach_recorded' }, run({ outreach: [row] }), ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'outreach_recorded', domain: 'VENDOR.example.test', confirmed: true }, run({ outreach: [row] }), ctx).rating).toBe('PASS');
  });

  it('misses on no row, another domain, or the other confirmed flag', () => {
    expect(evaluateCheck({ kind: 'outreach_recorded' }, run({}), ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'outreach_recorded', domain: 'other.example.test' }, run({ outreach: [row] }), ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'outreach_recorded', confirmed: false }, run({ outreach: [row] }), ctx).rating).toBe('MISS');
  });
});

describe('decision_recorded', () => {
  const r = run({ decisions: [{ label: 'SIN', decision: 'yes' }] });

  it('passes on the label and decision', () => {
    expect(evaluateCheck({ kind: 'decision_recorded', label: 'sin', decision: 'yes' }, r, ctx).rating).toBe('PASS');
  });

  it('misses on the other decision or another label', () => {
    expect(evaluateCheck({ kind: 'decision_recorded', label: 'SIN', decision: 'no' }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'decision_recorded', label: 'PASSPORT', decision: 'yes' }, r, ctx).rating).toBe('MISS');
  });
});
