import { describe, it, expect } from 'vitest';
import { loadYamlConfig } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-'));
  fs.writeFileSync(path.join(dir, 'default.yaml'), content);
  return dir;
}

describe('loadYamlConfig: documentWorkspace.scratchTtlDays', () => {
  it('accepts a valid positive integer', () => {
    const dir = writeTempConfig(`documentWorkspace:\n  scratchTtlDays: 14\n`);
    const config = loadYamlConfig(dir);
    expect(config.documentWorkspace?.scratchTtlDays).toBe(14);
  });

  it('rejects zero', () => {
    const dir = writeTempConfig(`documentWorkspace:\n  scratchTtlDays: 0\n`);
    expect(() => loadYamlConfig(dir)).toThrow('documentWorkspace.scratchTtlDays');
  });

  it('rejects values above the supported maximum', () => {
    const dir = writeTempConfig(`documentWorkspace:\n  scratchTtlDays: 36501\n`);
    expect(() => loadYamlConfig(dir)).toThrow('documentWorkspace.scratchTtlDays');
  });

  it('rejects a non-mapping documentWorkspace block', () => {
    const dir = writeTempConfig(`documentWorkspace: 7\n`);
    expect(() => loadYamlConfig(dir)).toThrow('documentWorkspace must be a YAML mapping');
  });

  it('is absent when documentWorkspace block is omitted', () => {
    const dir = writeTempConfig(`skillOutput:\n  maxLength: 100000\n`);
    const config = loadYamlConfig(dir);
    expect(config.documentWorkspace?.scratchTtlDays).toBeUndefined();
  });
});

describe('loadYamlConfig: documentWorkspace.consoleEditMaxBytes (#1822)', () => {
  it('accepts an integer within range', () => {
    const dir = writeTempConfig(`documentWorkspace:\n  consoleEditMaxBytes: 131072\n`);
    expect(loadYamlConfig(dir).documentWorkspace?.consoleEditMaxBytes).toBe(131072);
  });

  it.each(['0', '1023', '4194305', '65536.5', '"64k"'])('rejects %s', (value) => {
    const dir = writeTempConfig(`documentWorkspace:\n  consoleEditMaxBytes: ${value}\n`);
    expect(() => loadYamlConfig(dir)).toThrow('documentWorkspace.consoleEditMaxBytes');
  });

  it('ships the 64 KiB default in config/default.yaml', () => {
    const config = loadYamlConfig(path.join(import.meta.dirname, '../../config'));
    expect(config.documentWorkspace?.consoleEditMaxBytes).toBe(65536);
  });
});
