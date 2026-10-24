// Stall, write-ahead, and sizing limits for the email inbound runner.
//
// Lives beside the adapter so the health probe can import the threshold
// without the adapter importing the health module (that module stays on
// structural interfaces and does not depend on channel classes).

import { INBOUND_REPLAY_LIMIT } from '../../audit/inbound-replay.js';

/** Nylas list page size used by the email poll. */
export const EMAIL_POLL_PAGE_SIZE = 25;

/**
 * Nylas ids already written ahead in this process. Sized for a full replay
 * plus one poll page, so the oldest replayed id is still present when the
 * watermark is behind it and the next poll re-fetches that page.
 */
export const MAX_STAGED_INBOUND_IDS = INBOUND_REPLAY_LIMIT + EMAIL_POLL_PAGE_SIZE;

/** An in-flight turn or a queued message held this long fails the email check. */
export const EMAIL_INBOUND_TURN_STALL_MS = 15 * 60 * 1000;

/**
 * Consecutive write-ahead failures for one Nylas message before the poll
 * skips it. A deterministic audit failure (for example a lone surrogate in
 * the subject) must not wedge every newer message behind it. A database
 * outage does not count: that mail is retried until the database answers.
 */
export const WRITE_AHEAD_RETRY_LIMIT = 3;

/**
 * Consecutive polls that stop on a retryable write-ahead failure before
 * email health fails. One poison message is skipped on its last attempt, so
 * that poll completes and the counter resets. A database outage retries the
 * same message and still increments this counter, so health stays failed
 * for the length of the outage.
 */
export const WRITE_AHEAD_POLL_FAIL_LIMIT = 3;
