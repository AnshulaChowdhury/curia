import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../../../src/inbox-triage/types.js';

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
