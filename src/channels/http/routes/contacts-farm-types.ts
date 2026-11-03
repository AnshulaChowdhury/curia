import type { FarmStatus } from '../../../contacts-import/farm-store.js';

export interface FarmMailboxStatus {
  accountId: string;
  /** Whether a scan may be started now, and if not, why. */
  eligible: boolean;
  reason?: 'skipped' | 'not_connected' | 'no_category';
  status: FarmStatus | 'not_started';
  running: boolean;
  messagesScanned: number;
  peopleFound: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorKind: string | null;
}

export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'unknown_account' | 'skipped' | 'not_connected' | 'no_category' | 'already_running'; message: string };

export interface FarmService {
  status(): Promise<FarmMailboxStatus[]>;
  start(accountId: string, resume: boolean): Promise<StartResult>;
}
