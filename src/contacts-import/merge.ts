// merge.ts — one person, one record. The same person often appears in several sources (a WhatsApp contact and a Signal
// contact with the same number). Before the dry run, candidates that share an email or phone are merged into one, so
// the import service sees each person once and never has to guess.
//
// Matching is on exact normalised email or phone only. Names never merge people (two "Dana"s stay two people).

import type { ImportLabel } from './import-store.js';
import type { ImportPerson } from './import-service.js';

export interface Candidate {
  /** Stable id of the record in its own source, e.g. "bridge:whatsapp:123". */
  sourceKey: string;
  /** The source it came from, e.g. "bridge:whatsapp" or "mailbox:moonray". */
  sourceId: string;
  displayName: string;
  emails: string[];
  phones: string[];
  /** Work/personal suggestion from the source, when it has one. */
  label?: ImportLabel;
}

export interface MergedPerson {
  person: ImportPerson;
  /** Every source this person was found in. */
  sources: string[];
}

const MAX_IDENTIFIERS = 10;

/** A name that is just a number or an address tells us nothing about who the person is. */
export function isUsableName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !/^[+\d\s().-]+$/.test(n) && !n.includes('@');
}

function bestName(names: string[]): string {
  return [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0] ?? '';
}

function mergeLabels(labels: ImportLabel[]): ImportLabel | undefined {
  const set = new Set(labels);
  if (set.size === 0) return undefined;
  if (set.has('hybrid') || (set.has('work') && set.has('personal'))) return 'hybrid';
  return set.has('work') ? 'work' : 'personal';
}

/** Merges candidates that share an identifier. Candidates with no usable name are dropped and counted. */
export function mergeCandidates(candidates: Candidate[]): { people: MergedPerson[]; noName: number } {
  const usable = candidates.filter((c) => isUsableName(c.displayName));
  const noName = candidates.length - usable.length;

  const parent = usable.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== r) { const next = parent[i]!; parent[i] = r; i = next; }
    return r;
  };
  const owner = new Map<string, number>(); // identifier -> first candidate that had it
  usable.forEach((c, i) => {
    for (const id of [...c.emails.map((e) => `e:${e}`), ...c.phones.map((p) => `p:${p}`)]) {
      const seen = owner.get(id);
      if (seen === undefined) owner.set(id, i);
      else parent[find(i)] = find(seen);
    }
  });

  const groups = new Map<number, Candidate[]>();
  usable.forEach((c, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  });

  const people: MergedPerson[] = [];
  for (const members of groups.values()) {
    const label = mergeLabels(members.flatMap((m) => (m.label ? [m.label] : [])));
    const emails = [...new Set(members.flatMap((m) => m.emails))].sort().slice(0, MAX_IDENTIFIERS);
    const phones = [...new Set(members.flatMap((m) => m.phones))].sort().slice(0, MAX_IDENTIFIERS);
    people.push({
      person: {
        sourceKey: members.map((m) => m.sourceKey).sort()[0]!,
        displayName: bestName(members.map((m) => m.displayName.trim())),
        ...(emails.length ? { emails } : {}),
        ...(phones.length ? { phones } : {}),
        ...(label ? { suggestedLabel: label } : {}),
      },
      sources: [...new Set(members.map((m) => m.sourceId))].sort(),
    });
  }
  people.sort((a, b) => (a.person.sourceKey < b.person.sourceKey ? -1 : 1));
  return { people, noName };
}
