// Bounds for replaying unacknowledged inbound.message rows on email start.
//
// The audit query needs these. Email-adapter sizing that depends on them
// (the staged-id set) lives in channels/email/inbound-stall.ts.

/** How many unacknowledged inbound rows one account loads on start. */
export const INBOUND_REPLAY_LIMIT = 500;

/**
 * Rows older than this are not replayed. A restart never takes this long,
 * and mail from a previous deploy was already handled by the re-fetch that
 * used to run on boot (#2254).
 */
export const INBOUND_REPLAY_MAX_AGE_HOURS = 24;

/**
 * Rows that aged out of the replay window within this many hours are counted
 * and warned about on start. Older rows stay unacknowledged forever and are
 * already reported by the startup scan, so warning about them every boot
 * would only be noise.
 */
export const INBOUND_REPLAY_AGED_OUT_WARN_HOURS = 7 * 24;
