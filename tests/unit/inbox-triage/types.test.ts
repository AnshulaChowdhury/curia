import { describe, expect, it } from 'vitest';
import { TRIAGE_LABELS, isPushGroup, marksRead, parseVerdict, triageGroupOfLabel } from '../../../src/inbox-triage/types.js';

describe('parseVerdict', () => {
  it('accepts a confident urgent answer', () => {
    expect(parseVerdict('{"group":"urgent","confidence":0.9}', 0.6)).toEqual({ group: 'urgent', confidence: 0.9, unsure: false });
  });

  it('finds the JSON inside extra text', () => {
    expect(parseVerdict('Sure! {"group":"seen","confidence":0.8} done', 0.6).group).toBe('seen');
  });

  it('downgrades a low-confidence urgent to an unsure seen', () => {
    expect(parseVerdict('{"group":"urgent","confidence":0.3}', 0.6)).toEqual({ group: 'seen', confidence: 0.3, unsure: true });
  });

  it('downgrades a low-confidence drafted to an unsure seen', () => {
    expect(parseVerdict('{"group":"drafted","confidence":0.1}', 0.6).group).toBe('seen');
  });

  it('accepts confident newsletter and spam answers', () => {
    expect(parseVerdict('{"group":"newsletter","confidence":0.9}', 0.6)).toEqual({ group: 'newsletter', confidence: 0.9, unsure: false });
    expect(parseVerdict('{"group":"spam","confidence":0.95}', 0.6).group).toBe('spam');
  });

  it('never lets a low-confidence spam or newsletter guess hide mail: it becomes an unsure seen', () => {
    expect(parseVerdict('{"group":"spam","confidence":0.4}', 0.6)).toEqual({ group: 'seen', confidence: 0.4, unsure: true });
    expect(parseVerdict('{"group":"newsletter","confidence":0.5}', 0.6)).toEqual({ group: 'seen', confidence: 0.5, unsure: true });
  });

  it('keeps none as none', () => {
    expect(parseVerdict('{"group":"none","confidence":0.95}', 0.6).group).toBe('none');
  });

  it.each([
    ['not json'],
    ['{"group":"archive","confidence":0.9}'],
    ['{"group":"cleared","confidence":0.9}'],
    ['{"confidence":0.9}'],
    ['[1,2]'],
    [''],
  ])('treats %j as no verdict', (text) => {
    expect(parseVerdict(text, 0.6).group).toBe('none');
  });

  it('clamps confidence into 0..1 and treats a missing one as 0', () => {
    expect(parseVerdict('{"group":"seen","confidence":5}', 0.6).confidence).toBe(1);
    expect(parseVerdict('{"group":"seen"}', 0.6).confidence).toBe(0);
  });
});

describe('triage labels', () => {
  it('uses the agreed label names; spam is "Likely spam" because Gmail reserves "Spam"', () => {
    expect(TRIAGE_LABELS).toEqual({
      urgent: 'Urgent',
      drafted: 'Needs a reply',
      seen: 'FYI, no action needed',
      newsletter: 'Newsletter',
      spam: 'Likely spam',
    });
  });

  it('only urgent, needs-reply and FYI push; only newsletter and spam are marked read', () => {
    expect(['urgent', 'drafted', 'seen', 'newsletter', 'spam'].map((g) => isPushGroup(g as never))).toEqual([true, true, true, false, false]);
    expect(['urgent', 'drafted', 'seen', 'newsletter', 'spam'].map((g) => marksRead(g as never))).toEqual([false, false, false, true, true]);
  });

  it('maps current and earlier label names to a group, and never Gmail\'s SPAM folder', () => {
    expect(triageGroupOfLabel('Urgent')).toBe('urgent');
    expect(triageGroupOfLabel('✍️ Drafted')).toBe('drafted');
    expect(triageGroupOfLabel('Needs a reply')).toBe('drafted');
    expect(triageGroupOfLabel('📌 Seen')).toBe('seen');
    expect(triageGroupOfLabel('FYI, no action needed')).toBe('seen');
    expect(triageGroupOfLabel('Newsletter')).toBe('newsletter');
    expect(triageGroupOfLabel('Likely spam')).toBe('spam');
    expect(triageGroupOfLabel('SPAM')).toBeNull();
    expect(triageGroupOfLabel('Spam')).toBeNull();
    expect(triageGroupOfLabel('INBOX')).toBeNull();
  });
});
