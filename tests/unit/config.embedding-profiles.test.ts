import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig } from '../../src/config.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL } from '../../src/memory/embedding-profiles.js';

function writeTempConfigDir(opts: { defaultYaml: string; localYaml?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-embedding-cfg-'));
  fs.writeFileSync(path.join(dir, 'default.yaml'), opts.defaultYaml);
  if (opts.localYaml !== undefined) {
    fs.writeFileSync(path.join(dir, 'local.yaml'), opts.localYaml);
  }
  return dir;
}

describe('loadYamlConfig: embedding.profiles', () => {
  it('resolves a local.yaml profile with a base into a complete profile', () => {
    const dir = writeTempConfigDir({
      defaultYaml: 'skillOutput:\n  maxLength: 100\n',
      localYaml: `
embedding:
  profiles:
    proxy-id:
      base: text-embedding-3-small
      dimensions: 1024
`,
    });
    expect(loadYamlConfig(dir).embedding?.profiles).toEqual({
      'proxy-id': { ...OPENAI_TEXT_EMBEDDING_3_SMALL, model: 'proxy-id', dimensions: 1024 },
    });
  });

  it('fails loading on a malformed profile rather than running on part of it', () => {
    const dir = writeTempConfigDir({
      defaultYaml: `
embedding:
  profiles:
    custom:
      dimensions: 1024
`,
    });
    expect(() => loadYamlConfig(dir)).toThrow(/embedding\.profiles\["custom"\]\.thresholds\.fact_dedup/);
  });

  it('leaves the section absent when no profile is configured', () => {
    const dir = writeTempConfigDir({ defaultYaml: 'skillOutput:\n  maxLength: 100\n' });
    expect(loadYamlConfig(dir).embedding).toBeUndefined();
  });
});
