/**
 * Shared fixtures for attachment-resolution tests (#2281).
 *
 * Real and corrupted Gmail-via-Nylas IDs from the 2026-10-24 DMARC incident:
 * the model half-decoded the base64 content-type segment and wrote the literal
 * `name` back into the ID.
 */

/** Real Nylas attachment ID from message `1a16d5ec7cd97903`. */
export const DMARC_REAL_ATTACHMENT_ID =
  'v0:Z29vZ2xlLmNvbSFqb3NlcGhmdW5nLmNhITE3OTI3MTM2MDAhMTc5Mjc5OTk5OS56aXA=:YXBwbGljYXRpb24vemlwOyBuYW1lPSJnb29nbGUuY29tIWpvc2VwaGZ1bmcuY2EhMTc5MjcxMzYwMCExNzkyNzk5OTk5LnppcCI=:814';

/** Corrupted ID the model actually passed on 2026-10-24. */
export const DMARC_CORRUPTED_ATTACHMENT_ID =
  'v0:Z29vZ2xlLmNvbSFqb3NlcGhmdW5nLmNhITE3OTI3MTM2MDAhMTc5Mjc5OTk5OS56aXA=:YXBwbGljYXRpb24venppcDsgnamePSJnb29nbGUuY29tIWpvc2VwaGZ1bmcuY2EhMTc5MjcxMzYwMCExNzkyNzk5OTk5LnppcCI=:814';

export const DMARC_FILENAME = 'google.com!josephfung.ca!1792713600!1792799999.zip';
