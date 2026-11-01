// seen-store.ts — remembers classified message ids across restarts (FR-ETW-2).
//
// Keeps the most recent ids as one JSON array in the config store. An id that falls off the end is
// old enough that its mail is no longer both unread and untagged in practice; the sweep covers the rest.

import type { SeenStore } from './watcher.js';

export interface KeyValueStore {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<unknown>;
}

const NAMESPACE = 'system:inbox-triage';
const KEY = 'classified-ids';
const MAX_IDS = 500;

export class PersistedSeenStore implements SeenStore {
  private ids: string[] | undefined;

  constructor(private readonly store: KeyValueStore) {}

  private async load(): Promise<string[]> {
    if (this.ids) return this.ids;
    const raw = await this.store.get(NAMESPACE, KEY);
    let parsed: unknown = [];
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A corrupt row means "nothing remembered": the worst case is a few messages classified twice.
        parsed = [];
      }
    }
    this.ids = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    return this.ids;
  }

  async has(key: string): Promise<boolean> {
    return (await this.load()).includes(key);
  }

  async add(key: string): Promise<void> {
    const ids = await this.load();
    if (ids.includes(key)) return;
    ids.push(key);
    if (ids.length > MAX_IDS) ids.splice(0, ids.length - MAX_IDS);
    await this.store.set(NAMESPACE, KEY, JSON.stringify(ids));
  }
}
