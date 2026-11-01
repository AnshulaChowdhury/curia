import { describe, expect, it } from 'vitest';
import { PersistedSeenStore, type KeyValueStore } from '../../../src/inbox-triage/seen-store.js';

function kv(initial?: string): KeyValueStore & { value: string | null } {
  const s = { value: initial ?? null, get: async () => s.value, set: async (_n: string, _k: string, v: string) => { s.value = v; } };
  return s;
}

describe('PersistedSeenStore', () => {
  it('remembers ids across instances', async () => {
    const store = kv();
    await new PersistedSeenStore(store).add('a:1');
    expect(await new PersistedSeenStore(store).has('a:1')).toBe(true);
    expect(await new PersistedSeenStore(store).has('a:2')).toBe(false);
  });

  it('treats a corrupt row as empty', async () => {
    expect(await new PersistedSeenStore(kv('{not json')).has('a:1')).toBe(false);
  });

  it('keeps only the most recent 500 ids', async () => {
    const s = new PersistedSeenStore(kv());
    for (let i = 0; i < 510; i++) await s.add(`a:${i}`);
    expect(await s.has('a:0')).toBe(false);
    expect(await s.has('a:509')).toBe(true);
  });
});
