// The approvals waiting on the principal's answer (#2333): parsed from an untrusted payload,
// rendered with how to read a yes, a no, a changed request, or no answer at all.

import { describe, it, expect } from 'vitest';
import {
  AWAITING_ANSWER_HEADER,
  AWAITING_ANSWER_LINES,
  MAX_AWAITING_ANSWERS,
  REPLIED_TO_MARK,
  parseAwaitingAnswers,
  renderAwaitingAnswers,
} from '../../../../src/agents/prompts/awaiting-answers.js';

const ask = { number: 1, shortRef: 'abcd1234', description: 'Reply to Dana on signal.', question: 'Dana is asking for your email address.\nShare it?' };

describe('parseAwaitingAnswers', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(parseAwaitingAnswers([ask, { shortRef: '', description: 'x' }, { shortRef: 'x' }, 'nope', null])).toEqual([ask]);
    expect(parseAwaitingAnswers({ shortRef: 'x' })).toEqual([]);
    expect(parseAwaitingAnswers(undefined)).toEqual([]);
  });

  it('reads a bad number as none, keeps repliedTo only when true, and caps the list', () => {
    expect(parseAwaitingAnswers([{ ...ask, number: 0, repliedTo: 'yes' }])).toEqual([{ ...ask, number: null }]);
    expect(parseAwaitingAnswers([{ ...ask, repliedTo: true }])[0]!.repliedTo).toBe(true);
    expect(parseAwaitingAnswers(Array.from({ length: 9 }, (_, i) => ({ ...ask, shortRef: `ref${i}` })))).toHaveLength(MAX_AWAITING_ANSWERS);
  });
});

describe('renderAwaitingAnswers', () => {
  it('is null with nothing waiting', () => {
    expect(renderAwaitingAnswers([])).toBeNull();
  });

  it('lists each by number, with its question on one line, then how to read an answer', () => {
    const block = renderAwaitingAnswers([ask, { number: null, shortRef: 'ffff0000', description: 'Calendar event' }])!;
    expect(block.startsWith(AWAITING_ANSWER_HEADER)).toBe(true);
    expect(block).toContain('- Approval 1: Reply to Dana on signal. Asked: "Dana is asking for your email address. Share it?"');
    expect(block).toContain('- Approval ffff0000: Calendar event.');
    expect(block.endsWith(AWAITING_ANSWER_LINES.join('\n'))).toBe(true);
    expect(block).not.toContain(REPLIED_TO_MARK);
  });

  it('marks the one their message replies to', () => {
    expect(renderAwaitingAnswers([{ ...ask, repliedTo: true }])).toContain(`Share it?" ${REPLIED_TO_MARK}`);
  });

  it('covers a yes, a no, a changed request and no answer, and never a guess', () => {
    const lines = AWAITING_ANSWER_LINES.join('\n');
    for (const term of ['approve-action', 'deny-action', 'make the send they described', 'leave it pending', 'Never approve on a guess']) {
      expect(lines).toContain(term);
    }
  });
});
