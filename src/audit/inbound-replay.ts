// Bounds for replaying unacknowledged inbound.message rows on email start.
//
// The audit logger and the email adapter both use these so the staged-id set
// cannot be smaller than one replay plus a poll page.

/** How many unacknowledged inbound rows one account loads on start. */
export const INBOUND_REPLAY_LIMIT = 500;

/**
 * Rows older than this are not replayed. A restart never takes this long,
 * and mail from a previous deploy was already handled by the re-fetch that
 * used to run on boot (#2254).
 */
export const INBOUND_REPLAY_MAX_AGE_HOURS = 24;

/** Nylas list page size used by the email poll. */
export const EMAIL_POLL_PAGE_SIZE = 25;

/**
 * Nylas ids already written ahead in this process. Sized for a full replay
 * plus one poll page, so the oldest replayed id is still present when the
 * watermark is behind it and the next poll re-fetches that page.
 */
export const MAX_STAGED_INBOUND_IDS = INBOUND_REPLAY_LIMIT + EMAIL_POLL_PAGE_SIZE;
