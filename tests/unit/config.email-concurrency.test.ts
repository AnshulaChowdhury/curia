// channels.email.max_concurrent_turns validation (#2254).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadYamlConfig } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-email-cfg-'));
  fs.writeFileSync(path.join(tempDir, 'default.yaml'), '');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeLocalYaml(content: string) {
  fs.writeFileSync(path.join(tempDir, 'local.yaml'), content);
}

describe('channels.email.max_concurrent_turns', () => {
  it('accepts a positive integer', () => {
    writeLocalYaml(`
channels:
  email:
    max_concurrent_turns: 2
`);
    expect(loadYamlConfig(tempDir).channels?.email?.max_concurrent_turns).toBe(2);
  });

  it('rejects zero', () => {
    writeLocalYaml(`
channels:
  email:
    max_concurrent_turns: 0
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /channels\.email\.max_concurrent_turns must be a positive integer/,
    );
  });

  it('rejects a fraction', () => {
    writeLocalYaml(`
channels:
  email:
    max_concurrent_turns: 1.5
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /channels\.email\.max_concurrent_turns must be a positive integer/,
    );
  });

  it('rejects a negative value', () => {
    writeLocalYaml(`
channels:
  email:
    max_concurrent_turns: -1
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /channels\.email\.max_concurrent_turns must be a positive integer/,
    );
  });
});
