// controller.ts — owns the running inbox-triage watcher so Settings changes take effect without a redeploy.
// reload() stops the current watcher (if any) and starts a fresh one from the vault. Calls are serialised so two
// quick saves cannot leave two watchers running.

import { startInboxTriage, type InboxTriageDeps, type RunningInboxTriage } from './start.js';

export interface InboxTriageStatus {
  running: boolean;
  accounts: string[];
}

export class InboxTriageController {
  private running: RunningInboxTriage | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: InboxTriageDeps) {}

  /** Re-reads the vault and restarts the watcher. Rejects if starting fails (the old watcher stays stopped). */
  reload(): Promise<void> {
    const next = this.queue.then(async () => {
      this.running?.stop();
      this.running = null;
      this.running = await startInboxTriage(this.deps);
    });
    this.queue = next.catch(() => {}); // keep the chain alive; the caller still sees the rejection via `next`
    return next;
  }

  stop(): void {
    this.running?.stop();
    this.running = null;
  }

  status(): InboxTriageStatus {
    return { running: this.running !== null, accounts: this.running?.accounts ?? [] };
  }
}
