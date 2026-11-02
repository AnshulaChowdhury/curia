import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

// A person's email that asks for an answer was filed as "FYI, no action needed" because the prompt told the model to
// choose seen when unsure whether a person was writing, and triage turns anything under the confidence cutoff into seen.
// The wording is pinned lightly; whether the model follows it is checked by hand on real emails, not here.
const agent = load(readFileSync(path.resolve(import.meta.dirname, '../../../agents/email-classifier.yaml'), 'utf8')) as {
  version: string;
  system_prompt: string;
};

describe('email-classifier prompt', () => {
  it('is version 0.3.0', () => {
    expect(agent.version).toBe('0.3.0');
  });

  it('sends mail a person wrote for an answer to "Needs a reply", not FYI', () => {
    expect(agent.system_prompt).toMatch(/real person wrote individually to the principal, expecting an\s+answer, is drafted/);
  });

  it('no longer sends "could be a person" mail to seen', () => {
    expect(agent.system_prompt).not.toMatch(/person writing to the principal, or you\s+are not sure, choose seen/);
  });

  it('keeps cold outreach from strangers out of "Needs a reply"', () => {
    expect(agent.system_prompt).toMatch(/pitches from strangers are not drafted/);
  });
});
