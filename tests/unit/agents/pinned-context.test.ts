// pinned_context (#2338): YAML validation and the per-turn `## Pinned context` block.
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import {
  createPinnedContextReader,
  DEFAULT_PINNED_CONTEXT_WARN_CHARS,
  parsePinnedContext,
  pinnedDocPaths,
  renderPinnedContextBlock,
  type PinnedContextReader,
} from '../../../src/agents/pinned-context.js';

const silent = pino({ level: 'silent' });

function reader(overrides: Partial<PinnedContextReader> = {}): PinnedContextReader {
  return {
    warnChars: 16_000,
    readDoc: vi.fn(async () => null),
    readConfig: vi.fn(async () => null),
    ...overrides,
  };
}

describe('parsePinnedContext', () => {
  it('returns [] when the field is absent', () => {
    expect(parsePinnedContext(undefined, 'a')).toEqual([]);
    expect(parsePinnedContext(null, 'a')).toEqual([]);
  });

  it('parses doc and config entries, normalizing the doc path', () => {
    expect(parsePinnedContext([
      { doc: 'shared/inbox/rules.md' },
      { config: ' ceo_inbox/decision_tagging ' },
    ], 'ceo-inbox')).toEqual([
      { kind: 'doc', path: '/shared/inbox/rules.md' },
      { kind: 'config', namespace: 'ceo_inbox', key: 'decision_tagging' },
    ]);
  });

  it.each([
    ['not a list', { doc: '/shared/a.md' }, /must be a list/],
    ['a bare string entry', ['/shared/a.md'], /exactly one of `doc` or `config`/],
    ['an unknown key', [{ file: '/shared/a.md' }], /exactly one of `doc` or `config`/],
    ['both keys', [{ doc: '/shared/a.md', config: 'a/b' }], /exactly one of `doc` or `config`/],
    ['an empty value', [{ doc: '  ' }], /non-empty string/],
    ['a doc outside /shared/', [{ doc: '/projects/x/a.md' }], /under \/shared\//],
    ['a doc that climbs out of /shared/', [{ doc: '/shared/../projects/a.md' }], /under \/shared\//],
    ['the /shared/ folder itself', [{ doc: '/shared/' }], /under \/shared\//],
    ['a reserved leaf', [{ doc: '/shared/log.md' }], /reserved file log\.md/],
    ['a whole namespace', [{ config: 'ceo_inbox' }], /exactly one `\/`/],
    ['two slashes', [{ config: 'a/b/c' }], /exactly one `\/`/],
    ['an empty key', [{ config: 'ceo_inbox/' }], /exactly one `\/`/],
    ['a duplicate', [{ doc: '/shared/a.md' }, { doc: 'shared/a.md' }], /duplicate entry doc:\/shared\/a\.md/],
  ])('rejects %s, naming the agent', (_label, raw, pattern) => {
    expect(() => parsePinnedContext(raw, 'my-agent')).toThrow(/agent 'my-agent'/);
    expect(() => parsePinnedContext(raw, 'my-agent')).toThrow(pattern);
  });

  it('pinnedDocPaths lists only the documents', () => {
    expect(pinnedDocPaths(parsePinnedContext([{ doc: '/shared/a.md' }, { config: 'n/k' }], 'a')))
      .toEqual(['/shared/a.md']);
  });
});

describe('renderPinnedContextBlock', () => {
  const entries = parsePinnedContext([{ doc: '/shared/inbox/rules.md' }, { config: 'ceo_inbox/decision_tagging' }], 'a');

  it('returns null when nothing is declared', async () => {
    expect(await renderPinnedContextBlock([], reader(), { agentId: 'a', logger: silent })).toBeNull();
  });

  it('renders each doc with its path, version and full content, and each config value', async () => {
    const content = '---\ntype: agent-settings\n---\n## Board mail\n- Do: label BOARD';
    const block = await renderPinnedContextBlock(entries, reader({
      readDoc: vi.fn(async () => ({ version: 7, content })),
      readConfig: vi.fn(async () => 'on'),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain('## Pinned context');
    expect(block).toContain('### Document /shared/inbox/rules.md (version 7)');
    expect(block).toContain(content);
    expect(block).toContain('### Config ceo_inbox/decision_tagging\n```\non\n```');
  });

  it('reads fresh on every call', async () => {
    let version = 1;
    const r = reader({ readDoc: vi.fn(async () => ({ version, content: `v${version}` })) });
    const opts = { agentId: 'a', logger: silent };
    expect(await renderPinnedContextBlock(entries, r, opts)).toContain('(version 1)');
    version = 2;
    expect(await renderPinnedContextBlock(entries, r, opts)).toContain('(version 2)');
  });

  it('renders a missing doc or key as not yet created', async () => {
    const block = await renderPinnedContextBlock(entries, reader(), { agentId: 'a', logger: silent });
    expect(block).toContain('### Document /shared/inbox/rules.md\n_Not yet created._');
    expect(block).toContain('### Config ceo_inbox/decision_tagging\n_Not set yet._');
  });

  it('renders a failed read as unavailable and logs a warning for each', async () => {
    const warn = vi.fn();
    const logger = { ...silent, warn } as unknown as typeof silent;
    const block = await renderPinnedContextBlock(entries, reader({
      readDoc: vi.fn(async () => { throw new Error('db down'); }),
      readConfig: vi.fn(async () => { throw new Error('kg down'); }),
    }), { agentId: 'ceo-inbox', logger });
    expect(block).toContain('### Document /shared/inbox/rules.md\n_Unavailable this turn');
    expect(block).toContain('### Config ceo_inbox/decision_tagging\n_Unavailable this turn');
    expect(block).not.toContain('Not yet created');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatchObject({ agentId: 'ceo-inbox', entry: 'doc:/shared/inbox/rules.md' });
  });

  it('warns above the size threshold and still injects in full', async () => {
    const warn = vi.fn();
    const logger = { ...silent, warn } as unknown as typeof silent;
    const content = 'x'.repeat(50);
    const block = await renderPinnedContextBlock(entries.slice(0, 1), reader({
      warnChars: 10,
      readDoc: vi.fn(async () => ({ version: 1, content })),
    }), { agentId: 'a', logger });
    expect(block).toContain(content);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ chars: 50, warnChars: 10 });
  });

  it('fences a document that contains its own code fence', async () => {
    const content = 'Rule\n```\ncode\n```';
    const block = await renderPinnedContextBlock(entries.slice(0, 1), reader({
      readDoc: vi.fn(async () => ({ version: 1, content })),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain(`\`\`\`\`\n${content}\n\`\`\`\``);
  });
});

describe('createPinnedContextReader', () => {
  it('serializes a document as OKF with its version, and returns null when missing', async () => {
    const row = { version: 4 };
    const repo = {
      read: vi.fn(async (path: string) => (path === '/shared/a.md' ? row : null)),
      toOkf: vi.fn(() => '---\ntype: agent-settings\n---\nbody'),
    } as unknown as WorkingDocsRepo;
    const r = createPinnedContextReader({ workingDocsRepo: repo, logger: silent });
    expect(r.warnChars).toBe(DEFAULT_PINNED_CONTEXT_WARN_CHARS);
    expect(await r.readDoc('/shared/a.md')).toEqual({ version: 4, content: '---\ntype: agent-settings\n---\nbody' });
    expect(await r.readDoc('/shared/b.md')).toBeNull();
  });

  it('throws, rather than reporting not-yet-created, when a service is missing', async () => {
    const r = createPinnedContextReader({ logger: silent, warnChars: 5 });
    expect(r.warnChars).toBe(5);
    await expect(r.readDoc('/shared/a.md')).rejects.toThrow(/not configured/);
    await expect(r.readConfig('n', 'k')).rejects.toThrow(/not configured/);
  });
});
