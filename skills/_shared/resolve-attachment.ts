/**
 * Resolve which attachment on a message the model meant to download.
 *
 * Gmail-via-Nylas attachment IDs are long opaque strings (90–180 chars). Models
 * regularly mistype them even when the correct value is in context (#2281) —
 * the same failure class as ADR-047 for recipient addresses. Filename is short
 * and readable; a sole attachment on a verified message is unambiguous. Prefer
 * those over fuzzy matching the opaque ID.
 */

import type { Logger } from '../../src/logger.js';

/** Minimal attachment shape both Nylas clients expose to download handlers. */
export interface ResolvableAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export type AttachmentResolvedBy = 'id' | 'filename' | 'sole_attachment';

export interface ResolveAttachmentSuccess {
  ok: true;
  attachment: ResolvableAttachment;
  resolvedBy: AttachmentResolvedBy;
}

export interface ResolveAttachmentFailure {
  ok: false;
  error: string;
}

export type ResolveAttachmentResult = ResolveAttachmentSuccess | ResolveAttachmentFailure;

export interface ResolveAttachmentOptions {
  attachments: readonly ResolvableAttachment[];
  /** Model-supplied attachment ID (may be empty, truncated, or garbled). */
  attachmentId?: string;
  /** Optional case-sensitive filename; preferred when the ID is unreliable. */
  filename?: string;
  messageId: string;
  log: Logger;
  /** Prefix for structured warn/info logs (skill name). */
  logContext: string;
}

/**
 * Format the attachments that exist on a message for an error string the model
 * can use on the next attempt (filename is the recommended retry key).
 */
export function formatAttachmentListing(attachments: readonly ResolvableAttachment[]): string {
  if (attachments.length === 0) {
    return 'Message has no attachments.';
  }
  const lines = attachments.map(
    (a) => `- filename=${JSON.stringify(a.filename)} size=${a.size} id=${a.id}`,
  );
  return `Attachments on this message:\n${lines.join('\n')}`;
}

/**
 * Resolve an attachment by exact ID, then unique filename, then sole-attachment
 * fallback. Returns a structured error listing available attachments when none
 * of those succeed.
 */
export function resolveAttachment(options: ResolveAttachmentOptions): ResolveAttachmentResult {
  const attachmentId = options.attachmentId?.trim() ?? '';
  const filename = options.filename?.trim() ?? '';
  const { attachments, messageId, log, logContext } = options;

  if (attachmentId) {
    const byId = attachments.find((a) => a.id === attachmentId);
    if (byId) {
      return { ok: true, attachment: byId, resolvedBy: 'id' };
    }
  }

  if (filename) {
    const byName = attachments.filter((a) => a.filename === filename);
    if (byName.length === 1) {
      const attachment = byName[0]!;
      log.warn(
        {
          messageId,
          requestedAttachmentId: attachmentId || undefined,
          resolvedAttachmentId: attachment.id,
          filename,
          resolvedBy: 'filename',
        },
        `${logContext}: resolved attachment by filename after ID miss`,
      );
      return { ok: true, attachment, resolvedBy: 'filename' };
    }
    if (byName.length > 1) {
      return {
        ok: false,
        error:
          `Filename ${JSON.stringify(filename)} matches ${byName.length} attachments on ` +
          `message ${messageId} — pass attachment_id to disambiguate. ` +
          formatAttachmentListing(attachments),
      };
    }
  }

  if (attachments.length === 1) {
    const attachment = attachments[0]!;
    log.warn(
      {
        messageId,
        requestedAttachmentId: attachmentId || undefined,
        requestedFilename: filename || undefined,
        resolvedAttachmentId: attachment.id,
        resolvedBy: 'sole_attachment',
      },
      `${logContext}: resolved sole attachment after ID/filename miss`,
    );
    return { ok: true, attachment, resolvedBy: 'sole_attachment' };
  }

  const requested = attachmentId
    ? `Attachment ${attachmentId}`
    : filename
      ? `Attachment with filename ${JSON.stringify(filename)}`
      : 'Attachment';

  return {
    ok: false,
    error:
      `${requested} not found on message ${messageId}. ` +
      `Pass filename (preferred) or the exact attachment_id from the message's attachments list. ` +
      formatAttachmentListing(attachments),
  };
}
