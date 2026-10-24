import { describe, it, expect, vi } from 'vitest';
import {
  resolveAttachment,
  formatAttachmentListing,
  attachmentSelectorPresent,
  type ResolvableAttachment,
} from './resolve-attachment.js';
import {
  DMARC_REAL_ATTACHMENT_ID,
  DMARC_CORRUPTED_ATTACHMENT_ID,
  DMARC_FILENAME,
} from './resolve-attachment.fixtures.js';
import type { Logger } from '../../src/logger.js';

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function att(
  id: string,
  filename: string,
  size = 814,
  contentType = 'application/zip',
): ResolvableAttachment {
  return { id, filename, contentType, size };
}

describe('attachmentSelectorPresent', () => {
  it('is false when both are missing or whitespace', () => {
    expect(attachmentSelectorPresent({})).toBe(false);
    expect(attachmentSelectorPresent({ attachmentId: '  ', filename: '  ' })).toBe(false);
  });

  it('is true when either selector is non-empty after trim', () => {
    expect(attachmentSelectorPresent({ attachmentId: 'att-1' })).toBe(true);
    expect(attachmentSelectorPresent({ filename: 'a.pdf' })).toBe(true);
  });
});

describe('resolveAttachment', () => {
  it('resolves by exact ID without warning', () => {
    const log = makeLog();
    const attachment = att(DMARC_REAL_ATTACHMENT_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: DMARC_REAL_ATTACHMENT_ID,
      messageId: '1a16d5ec7cd97903',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment, resolvedBy: 'id' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('falls back to sole_attachment for the 2026-10-24 corrupted ID fixture', () => {
    const log = makeLog();
    const attachment = att(DMARC_REAL_ATTACHMENT_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: DMARC_CORRUPTED_ATTACHMENT_ID,
      messageId: '1a16d5ec7cd97903',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({
      ok: true,
      attachment,
      resolvedBy: 'sole_attachment',
    });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedAttachmentId: DMARC_CORRUPTED_ATTACHMENT_ID,
      resolvedAttachmentId: DMARC_REAL_ATTACHMENT_ID,
      resolvedBy: 'sole_attachment',
    });
  });

  it('warns when resolving by filename after an ID miss', () => {
    const log = makeLog();
    const wanted = att('att-a', 'report.pdf', 100, 'application/pdf');
    const other = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [wanted, other],
      attachmentId: 'garble',
      filename: 'report.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment: wanted, resolvedBy: 'filename' });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedAttachmentId: 'garble',
      resolvedAttachmentId: 'att-a',
      filename: 'report.pdf',
      resolvedBy: 'filename',
    });
  });

  it('resolves by filename at info (not warn) when no ID is given', () => {
    const log = makeLog();
    const wanted = att('att-a', 'report.pdf');
    const other = att('att-b', 'photo.jpg');
    const result = resolveAttachment({
      attachments: [wanted, other],
      filename: 'report.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedBy).toBe('filename');
      expect(result.attachment.id).toBe('att-a');
    }
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('uses attachment_id when it matches even if filename names a different attachment', () => {
    const log = makeLog();
    const a = att('att-a', 'report.pdf', 100, 'application/pdf');
    const b = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [a, b],
      attachmentId: 'att-a',
      filename: 'photo.jpg',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment: a, resolvedBy: 'id' });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatch(/disagree/);
  });

  it('fails with listing when ID and filename miss on a multi-attachment message', () => {
    const log = makeLog();
    const a = att('att-a', 'report.pdf', 100, 'application/pdf');
    const b = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [a, b],
      attachmentId: 'wrong',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('wrong');
      expect(result.error).toContain('msg-1');
      expect(result.error).toContain('report.pdf');
      expect(result.error).toContain('photo.jpg');
      expect(result.error).toContain('att-a');
      expect(result.error).toContain('content_type=');
      expect(result.error).toContain('size=100');
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('fails when filename is ambiguous and tells the model to copy the listed id exactly', () => {
    const log = makeLog();
    const a = att('att-a', 'dup.pdf', 10, 'application/pdf');
    const b = att('att-b', 'dup.pdf', 20, 'application/pdf');
    const result = resolveAttachment({
      attachments: [a, b],
      attachmentId: 'wrong',
      filename: 'dup.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/matches 2 attachments/i);
      expect(result.error).toMatch(/copy the id exactly/i);
      expect(result.error).toContain('att-a');
      expect(result.error).toContain('att-b');
      expect(result.error).toContain('content_type=');
    }
  });

  it('does not sole-fallback when an explicit filename misses on a one-attachment message', () => {
    const log = makeLog();
    const attachment = att(DMARC_REAL_ATTACHMENT_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: DMARC_CORRUPTED_ATTACHMENT_ID,
      filename: 'other.zip',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('other.zip');
      expect(result.error).toContain(DMARC_FILENAME);
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('matches a filename that has leading/trailing whitespace on the attachment', () => {
    const log = makeLog();
    const padded = att('att-a', '  report.pdf  ', 100, 'application/pdf');
    const other = att('att-b', 'photo.jpg', 200, 'image/jpeg');
    const result = resolveAttachment({
      attachments: [padded, other],
      filename: '  report.pdf  ',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.id).toBe('att-a');
      expect(result.resolvedBy).toBe('filename');
    }
  });

  it('filename match is case-sensitive', () => {
    const log = makeLog();
    const a = att('att-a', 'Report.pdf');
    const b = att('att-b', 'photo.jpg');
    const result = resolveAttachment({
      attachments: [a, b],
      filename: 'report.pdf',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Report.pdf');
    }
  });

  it('returns a dedicated error when the message has no attachments', () => {
    const log = makeLog();
    const result = resolveAttachment({
      attachments: [],
      attachmentId: 'any',
      messageId: 'msg-empty',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Message msg-empty has no attachments — check message_id.',
    });
  });
});

describe('formatAttachmentListing', () => {
  it('describes an empty attachment list', () => {
    expect(formatAttachmentListing([])).toBe('Message has no attachments.');
  });

  it('lists filename, content_type, size, and id per attachment', () => {
    const listing = formatAttachmentListing([
      att('att-1', 'a.pdf', 10, 'application/pdf'),
      att('att-2', 'b.png', 20, 'image/png'),
    ]);
    expect(listing).toContain('filename="a.pdf" content_type="application/pdf" size=10 id=att-1');
    expect(listing).toContain('filename="b.png" content_type="image/png" size=20 id=att-2');
  });
});
