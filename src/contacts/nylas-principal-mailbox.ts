// nylas-principal-mailbox.ts — PrincipalMailbox over the principal's own Nylas grant (#2227).
//
// The same grant ceo-inbox reads (ceo_nylas_grant_id). It runs inside dispatch, ahead of
// the coordinator, so every lookup has a short deadline: a slow mailbox delays the turn by
// at most that, and a timeout reads as "no evidence" (PrincipalAcquaintanceCheck). The race
// returns at the deadline; the client is built with the same SDK timeout, so the request
// itself is aborted then too rather than left running (SDK 8.4 takes no AbortSignal).

import { NylasClient } from '../channels/email/nylas-client.js';
import type { Logger } from '../logger.js';
import { isPlainAddress, type PrincipalMailbox } from './principal-acquaintance.js';

const LOOKUP_TIMEOUT_MS = 5_000;
// A few results, not one: the native search is fuzzy, so each hit is checked for the
// address among its recipients.
const LOOKUP_LIMIT = 5;

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
      const messages = await Promise.race([
        this.client.listMessages({ searchQueryNative: `in:sent to:${address}`, limit: LOOKUP_LIMIT }),
        timeout,
      ]);
      const wanted = address.toLowerCase();
      return messages.some((m) => [...m.to, ...m.cc].some((p) => p.email.trim().toLowerCase() === wanted));
    } finally {
      clearTimeout(timer);
    }
  }
}
