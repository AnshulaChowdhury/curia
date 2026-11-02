// merge.test.ts — one person, one record: merging by exact identifier, never by name.

import { describe, it, expect } from 'vitest';
import { isUsableName, mergeCandidates, type Candidate } from '../../../src/contacts-import/merge.js';

const c = (key: string, name: string, extra: Partial<Candidate> = {}): Candidate =>
  ({ sourceKey: key, sourceId: key.split(':').slice(0, 2).join(':'), displayName: name, emails: [], phones: [], ...extra });

describe('isUsableName', () => {
  it('rejects names that are only a number or an address', () => {
    for (const bad of ['', '  ', '+1 (416) 555-0100', '14165550100', 'dana@example.org']) expect(isUsableName(bad)).toBe(false);
    for (const good of ['Dana', 'Dana Lee', 'D']) expect(isUsableName(good)).toBe(true);
  });
});

describe('mergeCandidates', () => {
  it('merges the same number found in two sources into one person that remembers both sources', () => {
    const { people } = mergeCandidates([
      c('bridge:whatsapp:1', 'Dana', { phones: ['+14165550100'] }),
      c('bridge:signal:9', 'Dana Lee', { phones: ['+14165550100'] }),
    ]);
    expect(people).toHaveLength(1);
    expect(people[0]!.person.displayName).toBe('Dana Lee');
    expect(people[0]!.person.sourceKey).toBe('bridge:signal:9');
    expect(people[0]!.sources).toEqual(['bridge:signal', 'bridge:whatsapp']);
  });

  it('merges through a chain: A shares a number with B, B shares an email with C', () => {
    const { people } = mergeCandidates([
      c('s:a:1', 'Dana', { phones: ['+14165550100'] }),
      c('s:b:1', 'Dana L', { phones: ['+14165550100'], emails: ['dana@example.org'] }),
      c('s:c:1', 'Dana Lee', { emails: ['dana@example.org'] }),
    ]);
    expect(people).toHaveLength(1);
    expect(people[0]!.person.phones).toEqual(['+14165550100']);
    expect(people[0]!.person.emails).toEqual(['dana@example.org']);
  });

  it('never merges two people only because they share a name', () => {
    const { people } = mergeCandidates([
      c('s:a:1', 'Dana Lee', { phones: ['+14165550100'] }),
      c('s:a:2', 'Dana Lee', { phones: ['+14165550199'] }),
    ]);
    expect(people).toHaveLength(2);
  });

  it('drops entries with no real name and counts them', () => {
    const r = mergeCandidates([c('s:a:1', '+14165550100', { phones: ['+14165550100'] }), c('s:a:2', 'Dana', { phones: ['+14165550199'] })]);
    expect(r.noName).toBe(1);
    expect(r.people.map(p => p.person.displayName)).toEqual(['Dana']);
  });

  it('a number shared with a nameless entry still joins the named person', () => {
    const r = mergeCandidates([c('s:a:1', '+14165550100', { phones: ['+14165550100'] }), c('s:b:1', 'Dana', { phones: ['+14165550100'] })]);
    expect(r.people).toHaveLength(1);
    expect(r.noName).toBe(1);
  });

  it('combines labels: work + personal is hybrid, a single label stays, none stays none', () => {
    const label = (a?: Candidate['label'], b?: Candidate['label']) => {
      const { people } = mergeCandidates([
        c('s:a:1', 'Dana', { phones: ['+14165550100'], ...(a ? { label: a } : {}) }),
        c('s:b:1', 'Dana', { phones: ['+14165550100'], ...(b ? { label: b } : {}) }),
      ]);
      return people[0]!.person.suggestedLabel;
    };
    expect(label('work', 'personal')).toBe('hybrid');
    expect(label('work', 'work')).toBe('work');
    expect(label('personal')).toBe('personal');
    expect(label('hybrid', 'work')).toBe('hybrid');
    expect(label()).toBeUndefined();
  });

  it('is stable: the same input in a different order gives the same people and source keys', () => {
    const input = [
      c('s:a:2', 'Bo', { phones: ['+14165550102'] }),
      c('s:a:1', 'Al', { phones: ['+14165550101'] }),
      c('s:b:1', 'Al B', { phones: ['+14165550101'] }),
    ];
    const one = mergeCandidates(input).people.map(p => p.person);
    const two = mergeCandidates([...input].reverse()).people.map(p => p.person);
    expect(two).toEqual(one);
  });

  it('caps identifiers at ten per person', () => {
    const phones = Array.from({ length: 14 }, (_, i) => `+1416555${String(1000 + i)}`);
    const { people } = mergeCandidates([c('s:a:1', 'Dana', { phones })]);
    expect(people[0]!.person.phones).toHaveLength(10);
  });
});
