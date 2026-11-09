import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '../../../ops/local-jobs/setup-local-job');
const base = {
  id: 'demo', label: 'Demo', repo: 'git@github.com:acme/demo.git', ref: 'v1.0.0', macos_user: 'demo',
  entry: 'scripts/run.sh', interval_seconds: 60, install: [], import_check: [], secrets: [{ name: 'X_TOKEN', source: 'curia' }],
};

function run(manifest: Record<string, unknown>, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'slj-'));
  const f = join(dir, 'job.json');
  writeFileSync(f, JSON.stringify(manifest));
  return spawnSync('/bin/bash', [SCRIPT, 'install', f, ...args], { encoding: 'utf8', input: '' });
}

describe('setup-local-job', () => {
  it('has valid bash syntax', () => {
    expect(spawnSync('/bin/bash', ['-n', SCRIPT]).status).toBe(0);
  });
  it('--dry-run prints the plan and changes nothing', () => {
    const r = run(base, '--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain('sysadminctl -addUser demo');
    expect(r.stdout).not.toContain('-admin');
    expect(r.stdout).toContain('would prompt for X_TOKEN');
  });
  it.each([
    ['unsafe user', { macos_user: 'a;rm -rf /' }],
    ['path traversal in entry', { entry: '../x.sh' }],
    ['absolute entry', { entry: '/etc/x.sh' }],
    ['shell in ref', { ref: 'v1;ls' }],
    ['placeholder repo', { repo: 'git@github.com:CHANGE-ME/CHANGE-ME.git' }],
    ['path traversal in subdir', { subdir: '../x' }],
    ['absolute subdir', { subdir: '/etc' }],
  ])('rejects %s', (_n, patch) => {
    const r = run({ ...base, ...patch }, '--dry-run');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Stopped:/);
  });

  it('installs a job that lives in a folder of a bigger repo: only that folder, run from there', () => {
    const r = run({ ...base, subdir: 'jobs/demo', settings: [{ name: 'DEMO_URL' }] }, '--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--no-checkout --filter=blob:none');
    expect(r.stdout).toContain("git sparse-checkout set --cone 'jobs/demo'");
    expect(r.stdout).toContain('would prompt for DEMO_URL (setting)');
  });

  it('the shipped contacts manifest passes a dry run', () => {
    const r = spawnSync('/bin/bash', [SCRIPT, 'install', 'contacts', '--dry-run'], { encoding: 'utf8', input: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('folder jobs/contacts-export');
    expect(r.stdout).toContain('would prompt for MATRIX_ACCESS_TOKEN');
    expect(r.stdout).toContain('would prompt for MATRIX_HOMESERVER_URL (setting)');
  });

  it('every prompt in the secrets loop reads from the keyboard, not the loop\'s piped list', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const body = src.slice(src.indexOf('collect_secrets() {'), src.indexOf('# ---- doctor'));
    const reads = body.split('\n').filter((l) => /\bread -r/.test(l) && !l.includes('IFS=$'));
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const l of reads) expect(l).toContain('</dev/tty');
  });
});
