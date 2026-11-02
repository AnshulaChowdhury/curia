import { describe, it, expect } from 'vitest';
import { buildRows, bundleGap, bundleGapMessage, enableWithBundlesPrompt, collateralPins, formatCapabilities, registryPathSegment, uninstallBlockedReason } from './registry-rows.js';
import type { RegistryEntry } from './registry-rows.js';

const entry = (name: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name, kind: 'tool', state: 'enabled', metadata: null,
  installedAt: null, installedBy: null, enabledAt: null, enabledBy: null, ...over,
});

const bundle = (name: string, tools: string[], pinnedBy: string[], state: RegistryEntry['state']) =>
  entry(name, {
    kind: 'skill', state,
    metadata: { name, description: 'd', version: '1.0.0', tools, pinnedBy },
  });

describe('registryPathSegment', () => {
  // Regression guard for finding #1: the drawer's act() used to route on the *page's*
  // kind (`kindPath`) instead of the entry's own kind, so a bundle row (kind: 'skill')
  // rendered on the /tools page sent every action to /api/registry/tools/:name — which
  // 400s because no tool manifest exists under the bundle's name. Nothing exercised the
  // request URL before, so this pins the mapping directly.
  it('maps a bundle (skill) entry to the skills segment', () => {
    expect(registryPathSegment('skill')).toBe('skills');
  });

  it('maps a tool entry to the tools segment', () => {
    expect(registryPathSegment('tool')).toBe('tools');
  });

  it('maps an agent entry to the agents segment', () => {
    expect(registryPathSegment('agent')).toBe('agents');
  });
});

describe('buildRows', () => {
  it('nests member tools under their bundle and leaves standalone tools flat', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled')],
      [entry('ceo-inbox-list'), entry('delegate')],
      [],
    );

    expect(rows.map(r => r.entry.name)).toEqual(['ceo-inbox', 'delegate']);
    expect(rows[0]!.rowKind).toBe('bundle');
    expect(rows[0]!.members.map(m => m.name)).toEqual(['ceo-inbox-list']);
    expect(rows[1]!.rowKind).toBe('tool');
    expect(rows[1]!.members).toEqual([]);
  });

  it('flags a non-enabled bundle pinned by an enabled agent', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list'], ['ceo-inbox'], 'installed')],
      [entry('ceo-inbox-list')],
      [entry('ceo-inbox', { kind: 'agent', state: 'enabled' })],
    );

    expect(rows[0]!.unresolvedFor).toEqual(['ceo-inbox']);
  });

  it('does not flag when the pinning agent is itself disabled', () => {
    const rows = buildRows(
      [bundle('learning', ['learn-x'], ['digest'], 'installed')],
      [entry('learn-x')],
      [entry('digest', { kind: 'agent', state: 'installed' })],
    );

    expect(rows[0]!.unresolvedFor).toEqual([]);
  });

  it('shows members for a bundle that is not installed', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list', 'ceo-inbox-read'], [], 'uninstalled')],
      [entry('ceo-inbox-list'), entry('ceo-inbox-read')],
      [],
    );

    expect(rows[0]!.members).toHaveLength(2);
  });

  it('keeps an orphaned member visible as a standalone row when its bundle has no manifest', () => {
    // Ghost bundle: DB row with no manifest, so metadata (and membership) is null.
    // The member must still appear somewhere — as a standalone row, not vanish.
    const rows = buildRows(
      [entry('ghost-bundle', { kind: 'skill', state: 'ghost', metadata: null })],
      [entry('orphan-tool')],
      [],
    );

    expect(rows.map(r => r.entry.name)).toEqual(['ghost-bundle', 'orphan-tool']);
  });
});

describe('collateralPins', () => {
  const row = {
    entry: bundle('ceo-inbox', ['ceo-inbox-search', 'ceo-inbox-list'], [], 'enabled'),
    rowKind: 'bundle' as const,
    members: [entry('ceo-inbox-search'), entry('ceo-inbox-list')],
    pinnedBy: [],
    unresolvedFor: [],
  };

  it('reports member tools pinned individually by other agents', () => {
    const agents = [
      entry('T2125-expense-tracker', {
        kind: 'agent', state: 'enabled',
        metadata: { name: 'T2125-expense-tracker', description: 'd', version: '1.0.0',
          pinnedTools: ['ceo-inbox-search'] },
      }),
    ];

    expect(collateralPins(row, agents)).toEqual([
      { tool: 'ceo-inbox-search', agents: ['T2125-expense-tracker'] },
    ]);
  });

  // Brief's original name implied this exercises "the bundle owner itself" too, but the
  // assertion below only ever covers the empty-agents case — renamed to match reality.
  it('returns nothing when no other agent pins a member', () => {
    expect(collateralPins(row, [])).toEqual([]);
  });
});

describe('uninstallBlockedReason', () => {
  it('blocks an enabled bundle and explains the member-tool consequence', () => {
    const reason = uninstallBlockedReason(
      bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled'),
    );
    expect(reason).toMatch(/disable/i);
    expect(reason).toMatch(/member tool/i);
  });

  it('allows an installed-but-not-enabled bundle', () => {
    expect(
      uninstallBlockedReason(bundle('ceo-inbox', ['ceo-inbox-list'], [], 'installed')),
    ).toBeNull();
  });

  it('allows a ghost bundle — clearing the row is the only way to remove one', () => {
    // A ghost has a registry row but no manifest, so its members are unknowable and the
    // server permits the delete. The console must not be stricter than the server here,
    // or the row becomes unremovable from the UI.
    expect(
      uninstallBlockedReason(entry('dead-bundle', { kind: 'skill', state: 'ghost' })),
    ).toBeNull();
  });

  it('never blocks a plain tool or an agent, even when enabled', () => {
    expect(uninstallBlockedReason(entry('delegate', { state: 'enabled' }))).toBeNull();
    expect(
      uninstallBlockedReason(entry('coordinator', { kind: 'agent', state: 'enabled' })),
    ).toBeNull();
  });
});

describe('uninstallBlockedReason — must mirror the server, not exceed it', () => {
  it('allows an enabled bundle whose manifest failed to parse', () => {
    // metadata === null means the member list is unreadable. The server permits this delete
    // precisely because there is no cascade route: disable() also rejects it, so blocking
    // here too would leave the row with no console action at all. Note the derived state is
    // 'enabled' (not 'ghost') — the directory IS on disk, its SKILL.md just doesn't parse —
    // which is why keying only on state was wrong.
    expect(
      uninstallBlockedReason(
        entry('broken-bundle', { kind: 'skill', state: 'enabled', metadata: null }),
      ),
    ).toBeNull();
  });

  it('still blocks an enabled bundle whose members are readable', () => {
    expect(
      uninstallBlockedReason(bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled')),
    ).not.toBeNull();
  });
});

describe('formatCapabilities (#2028)', () => {
  it('labels skill-activate taskRepo as optional beside its required capability', () => {
    expect(formatCapabilities(['skillRegistry'], ['taskRepo']))
      .toBe('skillRegistry · Optional: taskRepo');
  });

  it('renders a tool with no optional capabilities as it does today', () => {
    expect(formatCapabilities(['skillRegistry'], undefined)).toBe('skillRegistry');
    expect(formatCapabilities(['skillRegistry'], [])).toBe('skillRegistry');
    expect(formatCapabilities(['bus', 'agentRegistry'], undefined)).toBe('bus, agentRegistry');
    expect(formatCapabilities([], undefined)).toBe('—');
    expect(formatCapabilities(undefined, undefined)).toBeNull();
  });

  it('shows an optional-only list without a required prefix', () => {
    expect(formatCapabilities(undefined, ['taskRepo'])).toBe('Optional: taskRepo');
    expect(formatCapabilities([], ['taskRepo', 'verification'])).toBe('Optional: taskRepo, verification');
  });
});

describe('an agent whose skill bundles are off', () => {
  const agent = (state: RegistryEntry['state'], unresolvedBundles?: string[]) =>
    entry('books', { kind: 'agent', state, unresolvedBundles });

  it('is a gap only for an enabled agent', () => {
    expect(bundleGap(agent('enabled', ['books']))).toEqual(['books']);
    expect(bundleGap(agent('installed', ['books']))).toEqual([]);     // not enabled yet: nothing is missing yet
    expect(bundleGap(agent('enabled', []))).toEqual([]);
    expect(bundleGap(agent('enabled'))).toEqual([]);                  // an older server that does not send the field
    expect(bundleGap(entry('x', { kind: 'skill', unresolvedBundles: ['books'] }))).toEqual([]);
  });

  it('says what is wrong and how to fix it', () => {
    expect(bundleGapMessage(agent('enabled', ['books']))).toBe(
      '"books" pins the skill bundle "books", which is not enabled, so it has no tools from it. Enable it on the Tools page, or use the button below.');
    expect(bundleGapMessage(agent('enabled', ['a', 'b']))).toContain('bundles "a", "b", which are not enabled');
    expect(bundleGapMessage(agent('enabled', []))).toBeNull();
  });

  it('asks before enabling an agent whose bundles are off, and stays quiet otherwise', () => {
    const prompt = enableWithBundlesPrompt(agent('installed', ['books']))!;
    expect(prompt).toContain('Enable "books"?');
    expect(prompt).toContain('"books"');
    expect(prompt).toContain('will be enabled too');
    expect(prompt).toContain('next restart');
    expect(enableWithBundlesPrompt(agent('installed', []))).toBeNull();
    expect(enableWithBundlesPrompt(entry('t', { kind: 'tool', unresolvedBundles: ['x'] }))).toBeNull();
  });
});
