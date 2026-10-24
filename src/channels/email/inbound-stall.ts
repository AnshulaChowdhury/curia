// Stall and write-ahead limits for the email inbound runner.
//
// Lives beside the adapter so the health probe can import the threshold
// without the adapter importing the health module (that module stays on
// structural interfaces and does not depend on channel classes).

/** An in-flight turn or a queued message held this long fails the email check. */
export const EMAIL_INBOUND_TURN_STALL_MS = 15 * 60 * 1000;

/**
 * Consecutive write-ahead failures for one Nylas message before the poll
 * skips it. A deterministic audit failure (for example a lone surrogate in
 * the subject) must not wedge every newer message behind it.
 */
export const WRITE_AHEAD_RETRY_LIMIT = 3;

/**
 * Consecutive polls that stop on a retryable write-ahead failure before
 * email health fails. One poison message is skipped on its last attempt, so
 * that poll completes and the counter resets. An audit-database outage keeps
 * ending polls on the next message and stays visible.
 */
export const WRITE_AHEAD_POLL_FAIL_LIMIT = 3;
