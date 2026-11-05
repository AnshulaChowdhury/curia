import { describe, expect, it } from 'vitest';
import { cleanKeywordList, extractKeywords, keywordsMatch, normaliseKeyword, stem } from '../../../src/inbox-triage/keywords.js';

describe('stem', () => {
  it('lets common word forms meet', () => {
    expect(stem('invoices')).toBe(stem('invoice'));
    expect(stem('billing')).toBe(stem('bill'));
    expect(stem('charged')).toBe(stem('charge'));
    expect(stem('address')).toBe('address'); // "ss" is not a plural
  });
});

describe('extractKeywords', () => {
  it('picks the telling words, subject first, without filler', () => {
    const words = extractKeywords('Invoice 4471 is overdue', 'Hi Anshula, please see the attached invoice. Payment was due on 3 November. Thanks, Dana');
    expect(words.slice(0, 3)).toEqual(['invoice', 'overdue', 'payment']);
    for (const filler of ['please', 'thanks', 'the', 'hi']) expect(words).not.toContain(filler);
  });

  it('returns at most five lower-case words, each once, and never digits', () => {
    const words = extractKeywords('Quarterly Board Meeting Agenda Budget Review Forecast', 'agenda agenda 2027 budget Q4');
    expect(words).toHaveLength(5);
    expect(new Set(words).size).toBe(5);
    expect(words.every((w) => /^\p{Ll}+$/u.test(w))).toBe(true);
    expect(words.slice(0, 2)).toEqual(['agenda', 'budget']); // seen in both the subject and the preview
  });

  it('is empty when there is nothing worth keeping', () => {
    expect(extractKeywords('Hi', 'Thanks! 123')).toEqual([]);
  });
});

describe('keywordsMatch', () => {
  it('needs one word for a one-word rule and two for a longer rule', () => {
    expect(keywordsMatch(['invoice'], 'Your invoices are ready', '')).toBe(true);
    expect(keywordsMatch(['invoice', 'overdue'], 'Invoice attached', 'see below')).toBe(false);
    expect(keywordsMatch(['invoice', 'overdue'], 'Invoice attached', 'this payment is overdue')).toBe(true);
    expect(keywordsMatch([], 'anything', 'at all')).toBe(false);
  });
});

describe('normaliseKeyword and cleanKeywordList', () => {
  it('accepts lower-cased letters within the limits only', () => {
    expect(normaliseKeyword(' Invoice ')).toBe('invoice');
    for (const bad of ['', 'ab', 'x'.repeat(41), 'inv0ice', 'two words', 'a-b-c', 3, null]) expect(normaliseKeyword(bad)).toBeNull();
  });
  it('sorts and de-duplicates 1 to 5 valid words, and refuses anything else', () => {
    expect(cleanKeywordList(['Overdue', 'invoice', 'invoice'])).toEqual(['invoice', 'overdue']);
    expect(cleanKeywordList([])).toBeNull();
    expect(cleanKeywordList(['one', 'two', 'three', 'four', 'five', 'sixes'])).toBeNull();
    expect(cleanKeywordList(['invoice', 'bad word'])).toBeNull();
    expect(cleanKeywordList('invoice')).toBeNull();
  });
});
