// farm-facade.ts — what the routes use: eligibility + the scan service + stored progress, in one place.

import type { FarmMailboxStatus, FarmService, StartResult } from '../channels/http/routes/contacts-farm-types.js';
import type { MailboxCategoryStore } from '../phone-inbox/mailbox-category-store.js';
import { PHONE_INBOX_ACCOUNT_IDS, type PhoneInboxAccountConfig } from '../phone-inbox/phone-inbox-service.js';
import type { MailboxFarmService } from './farm-service.js';
import type { FarmStore } from './farm-store.js';
import { resolveFarmTarget } from './mailbox-contacts.js';

const WHY: Record<string, string> = {
  unknown_account: 'No such mailbox.',
  skipped: 'This mailbox is skipped for now.',
  not_connected: 'This mailbox is not connected to Nylas.',
  no_category: 'Waiting for Command Hub (Android Launcher) to report the category.',
};

export class FarmFacade implements FarmService {
  constructor(
    private readonly store: FarmStore,
    private readonly scans: MailboxFarmService,
    private readonly loadMailboxes: () => Promise<PhoneInboxAccountConfig[]>,
    private readonly categories: Pick<MailboxCategoryStore, 'get'>,
  ) {}

  async status(): Promise<FarmMailboxStatus[]> {
    const boxes = await this.loadMailboxes();
    const out: FarmMailboxStatus[] = [];
    for (const id of PHONE_INBOX_ACCOUNT_IDS) {
      const t = await resolveFarmTarget(id, boxes, this.categories);
      const run = await this.store.getRun(id);
      out.push({
        accountId: id,
        eligible: t.ok,
        ...(t.ok ? {} : { reason: t.reason as 'skipped' | 'not_connected' | 'no_category' }),
        status: run?.status ?? 'not_started',
        running: this.scans.isRunning(id),
        messagesScanned: run?.messagesScanned ?? 0,
        peopleFound: run ? await this.store.countFacts(id) : 0,
        startedAt: run?.startedAt ?? null,
        finishedAt: run?.finishedAt ?? null,
        errorKind: run?.errorKind ?? null,
      });
    }
    return out;
  }

  async start(accountId: string, resume: boolean): Promise<StartResult> {
    const t = await resolveFarmTarget(accountId, await this.loadMailboxes(), this.categories);
    if (!t.ok) return { ok: false, reason: t.reason, message: WHY[t.reason]! };
    if (this.scans.isRunning(accountId)) return { ok: false, reason: 'already_running', message: 'A scan of this mailbox is already running.' };
    await this.scans.start(t.target, { resume });
    return { ok: true };
  }
}
