import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadRegistryDefaults } from '../../../src/registry/reconcile.js';

// The bus rejects an agent.task for an agent the registry has not enabled ("no registered agent owns it"),
// which silently stopped every triage classification in production. Core agents are enabled from this file.
describe('email-classifier enrolment', () => {
  it('is in config/registry-defaults.yaml so a deployed Curia enables it', () => {
    const defaults = loadRegistryDefaults(path.resolve(import.meta.dirname, '../../../config/registry-defaults.yaml'));
    expect(defaults.agents).toContain('email-classifier');
  });
});
