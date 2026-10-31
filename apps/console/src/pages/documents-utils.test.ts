import { describe, expect, it } from 'vitest';
import {
  ancestorPrefixes,
  buildDocTree,
  describeExpiry,
  formatBytes,
  resolveDocHref,
  sortByUpdatedDesc,
  type DocSummary,
} from './documents-utils.js';

function doc(path: string, updatedAt = '2026-10-01T00:00:00.000Z', id = path): DocSummary {
  return {
    id, path, type: 'brief', title: null, version: 1, byteSize: 10,
    taskId: null, conversationId: null, agentId: null,
    createdAt: updatedAt, updatedAt, archivedAt: null, scratchExpiry: null,
  };
}

describe('buildDocTree', () => {
  const docs = [
    doc('/projects/social-media/activity-log.md'),
    doc('/projects/social-media/brief.md'),
    doc('/projects/3467d2d0/brief.md'),
    doc('/scratch/conv-1/draft.md'),
    doc('/root.md'),
  ];

  it('nests documents under their path prefixes with counts', () => {
    const tree = buildDocTree(docs);
    expect(tree.total).toBe(5);
    expect(tree.docs.map(d => d.path)).toEqual(['/root.md']);
    expect(tree.dirs.map(d => [d.prefix, d.total])).toEqual([['/projects/', 3], ['/scratch/', 1]]);
    const projects = tree.dirs[0]!;
    expect(projects.dirs.map(d => d.name)).toEqual(['3467d2d0', 'social-media']);
    expect(projects.dirs[1]!.docs.map(d => d.path)).toEqual([
      '/projects/social-media/activity-log.md',
      '/projects/social-media/brief.md',
    ]);
  });

  it('roots the tree at a prefix', () => {
    const tree = buildDocTree(docs, '/projects/social-media/');
    expect(tree.total).toBe(2);
    expect(tree.dirs).toEqual([]);
    expect(tree.docs).toHaveLength(2);
  });

  it('keeps rows that share a path (archived history) as separate leaves', () => {
    const tree = buildDocTree([doc('/a/x.md', '2026-10-01T00:00:00.000Z', '1'), doc('/a/x.md', '2026-10-02T00:00:00.000Z', '2')]);
    expect(tree.dirs[0]!.docs.map(d => d.id)).toEqual(['2', '1']);
  });
});

describe('helpers', () => {
  it('sorts newest first', () => {
    expect(sortByUpdatedDesc([doc('/a.md', '2026-01-01'), doc('/b.md', '2026-02-01')]).map(d => d.path)).toEqual(['/b.md', '/a.md']);
  });

  it('lists ancestor prefixes', () => {
    expect(ancestorPrefixes('/a/b/c.md')).toEqual(['/a/', '/a/b/']);
    expect(ancestorPrefixes('/c.md')).toEqual([]);
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(211 * 1024)).toBe('211.0 KiB');
  });

  it('describes scratch expiry', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(describeExpiry({ expiresAt: null, exempt: true, ttlDays: null }, now)).toMatch(/exempt/);
    expect(describeExpiry({ expiresAt: '2026-10-13T00:00:00Z', exempt: false, ttlDays: 7 }, now)).toMatch(/3 days/);
    expect(describeExpiry({ expiresAt: '2026-10-09T00:00:00Z', exempt: false, ttlDays: 7 }, now)).toMatch(/next scratch sweep/);
  });

  it('resolves in-store links like the link index does', () => {
    expect(resolveDocHref('/projects/x/brief.md', 'findings.md')).toBe('/projects/x/findings.md');
    expect(resolveDocHref('/projects/x/brief.md', '../y/a.md#part')).toBe('/projects/y/a.md');
    expect(resolveDocHref('/projects/x/brief.md', '/scratch/c/n.md')).toBe('/scratch/c/n.md');
    expect(resolveDocHref('/projects/x/brief.md', 'https://example.com')).toBeNull();
    expect(resolveDocHref('/projects/x/brief.md', 'mailto:a@b.c')).toBeNull();
    expect(resolveDocHref('/projects/x/brief.md', '#top')).toBeNull();
  });
});
