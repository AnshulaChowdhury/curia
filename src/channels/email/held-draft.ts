// held-draft.ts — find or delete a send-draft across mailboxes (#2340 review).
//
// send-draft's account input is optional. When the held payload names no mailbox,
// the draft is in whichever account created it. Deleting only the primary mailbox
// treats that account's 404 as "already gone" and leaves the real draft in place.

export interface HeldDraftMailbox<T> {
  listAccountIds: () => string[];
  getDraft: (accountId: string, draftId: string) => Promise<T | null>;
}

export interface HeldDraftDeleteMailbox<T> extends HeldDraftMailbox<T> {
  /** Deletes in one named account. A 404 from that account is success. */
  deleteDraft: (accountId: string, draftId: string) => Promise<void>;
}

/**
 * The mailbox that holds `draftId`.
 * A named account is the only one searched. Otherwise every configured account is,
 * and the first hit wins. Null when every search came back empty.
 * A lookup that throws fails the search: that mailbox might still hold the draft.
 */
export async function findHeldDraft<T>(
  draftId: string,
  account: string | undefined,
  mailbox: HeldDraftMailbox<T>,
): Promise<{ account: string; draft: T } | null> {
  const accounts = account ? [account] : mailbox.listAccountIds();
  if (accounts.length === 0) {
    throw new Error('Email client not configured');
  }
  let lookupFailed = false;
  for (const accountId of accounts) {
    let draft: T | null;
    try {
      draft = await mailbox.getDraft(accountId, draftId);
    } catch (err) {
      lookupFailed = true;
      // Keep the original failure when this is the only account, so a named
      // mailbox that rejects the read is not reported as "not found".
      if (account) throw err;
      continue;
    }
    if (draft) return { account: accountId, draft };
  }
  if (lookupFailed) {
    throw new Error('Could not search every mailbox for the draft');
  }
  return null;
}

/**
 * Delete a held draft.
 * A named account is deleted directly, so a 404 there means it is already gone.
 * With no account, delete only the mailbox that actually holds it. Success when
 * every mailbox came back empty. A lookup error is a failure: the draft may
 * still be in the mailbox that could not be read.
 */
export async function deleteHeldDraft<T>(
  draftId: string,
  account: string | undefined,
  mailbox: HeldDraftDeleteMailbox<T>,
): Promise<void> {
  if (account) {
    await mailbox.deleteDraft(account, draftId);
    return;
  }
  const found = await findHeldDraft(draftId, undefined, mailbox);
  if (!found) return;
  await mailbox.deleteDraft(found.account, draftId);
}
