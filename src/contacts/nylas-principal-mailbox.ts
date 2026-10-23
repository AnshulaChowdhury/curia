// nylas-principal-mailbox.ts — PrincipalMailbox over the principal's own Nylas grant (#2227).
//
// The same grant ceo-inbox reads (ceo_nylas_grant_id). It runs inside dispatch, ahead of
// the coordinator, so every lookup has a short deadline: a slow mailbox delays the turn by
// at most that, and a timeout reads as "no evidence" (PrincipalAcquaintanceCheck). The race
// returns at the deadline; the client is built with the same SDK timeout, so the request
// itself is aborted then too rather than left running (SDK 8.4 takes no AbortSignal).
//
// The search is provider-neutral, since the grant may be Gmail, Microsoft or IMAP: the Sent
// folder is found by its `\Sent` attribute (Gmail calls it SENT, Outlook "Sent Items"), and
// messages in it are filtered with Nylas `any_email`. A native search (`in:sent to:…`) is
// Gmail syntax and finds nothing on other providers.

import { NylasClient } from '../channels/email/nylas-client.js';
import type { Logger } from '../logger.js';
import { isPlainAddress, type PrincipalMailbox } from './principal-acquaintance.js';

const LOOKUP_TIMEOUT_MS = 5_000;
// A few results, not one: each hit is checked for the address among its recipients, since
// any_email would also match the address as a sender.
const LOOKUP_LIMIT = 5;
const SENT_ATTRIBUTE = '\\Sent';

export class NylasPrincipalMailbox implements PrincipalMailbox {
  private readonly client: NylasClient;

  constructor(
    apiKey: string,
    grantId: string,
    logger: Logger,
    private readonly timeoutMs = LOOKUP_TIMEOUT_MS,
  ) {
    this.client = new NylasClient(apiKey, grantId, logger, timeoutMs);
  }

  async hasSentTo(address: string): Promise<boolean> {
    // The caller already checks this; repeated here because the value goes into a query.
    if (!isPlainAddress(address)) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`principal mailbox lookup timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    try {
      return await Promise.race([this.searchSent(address), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchSent(address: string): Promise<boolean> {
    // The client caches the folder list, so this costs a request only every few minutes.
    const sent = (await this.client.listFolders()).find((f) => f.attributes?.includes(SENT_ATTRIBUTE));
    // Thrown, not false: a mailbox with no Sent folder found is one we can't read, which is
    // not evidence that the principal never wrote.
    if (!sent) throw new Error('principal mailbox has no folder with the \\Sent attribute');
    const messages = await this.client.listMessages({ folders: [sent.id], anyEmail: address, limit: LOOKUP_LIMIT });
    const wanted = address.toLowerCase();
    return messages.some((m) => [...m.to, ...m.cc].some((p) => p.email.trim().toLowerCase() === wanted));
  }
}
