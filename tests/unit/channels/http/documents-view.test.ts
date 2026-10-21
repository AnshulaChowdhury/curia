import { describe, expect, it } from 'vitest';
import {
  attachmentDisposition,
  documentMatches,
  downloadFilename,
  matchContext,
  renderBodyChunks,
  scratchExpiry,
  splitMarkdownForProgressiveRender,
} from '../../../../src/channels/http/documents-view.js';
import type { WorkingDocRow } from '../../../../src/db/working-docs-repo.js';

function doc(overrides: Partial<WorkingDocRow>): WorkingDocRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    path: '/projects/x/brief.md',
    type: 'brief',
    frontmatter: {},
    body: '',
    version: 1,
    sectionVersions: {},
    byteSize: 0,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('splitMarkdownForProgressiveRender', () => {
  it('returns a small body as one chunk', () => {
    expect(splitMarkdownForProgressiveRender('# Hi\n\nShort.\n')).toEqual(['# Hi\n\nShort.\n']);
  });

  it('splits a large log at heading boundaries and reassembles exactly', () => {
    const entry = (i: number) => `## [2026-10-${String(i % 28 + 1).padStart(2, '0')}] post | entry ${i}\n\n${'Posted an update. '.repeat(40)}\n`;
    const body = Array.from({ length: 300 }, (_, i) => entry(i)).join('\n');
    expect(Buffer.byteLength(body)).toBeGreaterThan(200_000);

    const chunks = splitMarkdownForProgressiveRender(body);
    expect(chunks.length).toBeGreaterThan(8);
    expect(chunks.join('')).toBe(body);
    for (const chunk of chunks.slice(1)) expect(chunk.startsWith('## ')).toBe(true);
  });

  it('never splits inside a fenced code block', () => {
    const fenced = ['```', ...Array.from({ length: 2000 }, (_, i) => `line ${i}`), '', '## not a heading', '```'].join('\n');
    const body = `${'# Intro\n\n'}${fenced}\n\n## After\n\ntext\n`;
    const chunks = splitMarkdownForProgressiveRender(body, 1024);
    expect(chunks.join('')).toBe(body);
    const holder = chunks.find(c => c.includes('line 0'))!;
    expect(holder).toContain('line 1999');
    expect(holder).toContain('## not a heading');
  });

  it('falls back to any blank line when a document has no headings', () => {
    const body = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join('\n\n');
    const chunks = splitMarkdownForProgressiveRender(body, 4096);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join('')).toBe(body);
  });

  it('renders each chunk to sanitized HTML', () => {
    const chunks = renderBodyChunks('# Title\n\n<script>alert(1)</script>\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('<h1>Title</h1>');
    expect(chunks[0]).not.toContain('<script>');
  });
});

describe('scratchExpiry', () => {
  const updatedAt = '2026-10-10T12:00:00.000Z';

  it('is null outside /scratch/<conversation>/', () => {
    expect(scratchExpiry({ path: '/projects/a/b.md', frontmatter: {}, updatedAt, archivedAt: null }, 7)).toBeNull();
    expect(scratchExpiry({ path: '/scratch/root.md', frontmatter: {}, updatedAt, archivedAt: null }, 7)).toBeNull();
  });

  it('adds the default TTL to updated_at', () => {
    expect(scratchExpiry({ path: '/scratch/c1/n.md', frontmatter: {}, updatedAt, archivedAt: null }, 7)).toEqual({
      expiresAt: '2026-10-17T12:00:00.000Z',
      exempt: false,
      ttlDays: 7,
    });
  });

  it('honours a ttl_days override', () => {
    const result = scratchExpiry({ path: '/scratch/c1/n.md', frontmatter: { ttl_days: 2 }, updatedAt, archivedAt: null }, 7);
    expect(result?.expiresAt).toBe('2026-10-12T12:00:00.000Z');
  });

  it('marks ttl_days: 0 as exempt', () => {
    expect(scratchExpiry({ path: '/scratch/c1/n.md', frontmatter: { ttl_days: 0 }, updatedAt, archivedAt: null }, 7))
      .toEqual({ expiresAt: null, exempt: true, ttlDays: null });
  });

  it('is null for an archived row', () => {
    expect(scratchExpiry({ path: '/scratch/c1/n.md', frontmatter: {}, updatedAt, archivedAt: updatedAt }, 7)).toBeNull();
  });
});

describe('documentMatches', () => {
  it('matches path and body lines case-insensitively', () => {
    const matches = documentMatches(
      doc({ path: '/projects/Travel/plan.md', body: 'Flight to LISBON\nhotel\nlisbon dinner' }),
      'lisbon',
    );
    expect(matches.map(m => m.kind)).toEqual(['body', 'body']);
    expect(matches.map(m => (m.kind === 'body' ? m.lineNumber : 0))).toEqual([1, 3]);

    const pathMatches = documentMatches(doc({ path: '/projects/Travel/plan.md', body: 'travel notes' }), 'TRAVEL');
    expect(pathMatches.map(m => m.kind)).toEqual(['path', 'body']);
  });

  it('flags archived rows', () => {
    const [match] = documentMatches(doc({ body: 'hit', archivedAt: '2026-10-02T00:00:00.000Z' }), 'hit');
    expect(match?.archived).toBe(true);
  });
});

describe('matchContext', () => {
  it('returns short lines whole', () => {
    expect(matchContext('  a short line  ', 'short')).toBe('a short line');
  });

  it('windows a long line around the hit', () => {
    const line = `${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}`;
    const context = matchContext(line, 'needle', 100);
    expect(context).toContain('NEEDLE');
    expect(context.startsWith('…')).toBe(true);
    expect(context.endsWith('…')).toBe(true);
    expect(context.length).toBeLessThanOrEqual(102);
  });
});

describe('download naming', () => {
  it('suffixes the leaf with the version and a row-id fragment', () => {
    expect(downloadFilename('/projects/social-media/activity-log.md', 57, '3F2A9C1D-0000-4000-8000-000000000001'))
      .toBe('activity-log.v57.3f2a9c1d.md');
  });

  it('builds an RFC 6266 disposition with a UTF-8 fallback', () => {
    expect(attachmentDisposition('café "plan".v1.md')).toBe(
      `attachment; filename="caf_ _plan_.v1.md"; filename*=UTF-8''caf%C3%A9%20%22plan%22.v1.md`,
    );
  });
});
