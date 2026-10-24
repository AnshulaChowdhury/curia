import { describe, it, expect, vi } from 'vitest';
import {
  resolveAttachment,
  formatAttachmentListing,
  type ResolvableAttachment,
} from './resolve-attachment.js';
import type { Logger } from '../../src/logger.js';

/** Real ID from the 2026-10-24 DMARC incident (#2281). */
const REAL_ID =
  'v0:Z29vZ2xlLmNvbSFqb3NlcGhmdW5nLmNhITE3OTI3MTM2MDAhMTc5Mjc5OTk5OS56aXA=:YXBwbGljYXRpb24vemlwOyBuYW1lPSJnb29nbGUuY29tIWpvc2VwaGZ1bmcuY2EhMTc5MjcxMzYwMCExNzkyNzk5OTk5LnppcCI=:814';

/**
 * Corrupted ID the model actually passed: half-decoded the base64 content-type
 * segment and wrote the literal `name` back into the ID.
 */
const CORRUPTED_ID =
  'v0:Z29vZ2xlLmNvbSFqb3NlcGhmdW5nLmNhITE3OTI3MTM2MDAhMTc5Mjc5OTk5OS56aXA=:YXBwbGljYXRpb24venppcDsgnamePSJnb29nbGUuY29tIWpvc2VwaGZ1bmcuY2EhMTc5MjcxMzYwMCExNzkyNzk5OTk5LnppcCI=:814';

const DMARC_FILENAME = 'google.com!josephfung.ca!1792713600!1792799999.zip';

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
): ResolvableAttachment {
  return { id, filename, contentType: 'application/zip', size };
}

describe('resolveAttachment', () => {
  it('resolves by exact ID without warning', () => {
    const log = makeLog();
    const attachment = att(REAL_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: REAL_ID,
      messageId: '1a16d5ec7cd97903',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({ ok: true, attachment, resolvedBy: 'id' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('falls back to sole_attachment for the 2026-10-24 corrupted ID fixture', () => {
    const log = makeLog();
    const attachment = att(REAL_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: CORRUPTED_ID,
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
      requestedAttachmentId: CORRUPTED_ID,
      resolvedAttachmentId: REAL_ID,
      resolvedBy: 'sole_attachment',
    });
  });

  it('resolves by filename when ID misses on a multi-attachment message', () => {
    const log = makeLog();
    const wanted = att('att-a', 'report.pdf', 100);
    const other = att('att-b', 'photo.jpg', 200);
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
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toMatchObject({
      requestedAttachmentId: 'garble',
      resolvedAttachmentId: 'att-a',
      filename: 'report.pdf',
      resolvedBy: 'filename',
    });
  });

  it('resolves by filename when no ID is given', () => {
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
  });

  it('fails with listing when ID and filename miss on a multi-attachment message', () => {
    const log = makeLog();
    const a = att('att-a', 'report.pdf', 100);
    const b = att('att-b', 'photo.jpg', 200);
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
      expect(result.error).toContain('att-b');
      expect(result.error).toContain('size=100');
      expect(result.error).toContain('size=200');
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('fails when filename is ambiguous (two attachments share the name)', () => {
    const log = makeLog();
    const a = att('att-a', 'dup.pdf', 10);
    const b = att('att-b', 'dup.pdf', 20);
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
      expect(result.error).toContain('att-a');
      expect(result.error).toContain('att-b');
    }
  });

  it('falls back to sole_attachment when both ID and filename miss on a one-attachment message', () => {
    const log = makeLog();
    const attachment = att(REAL_ID, DMARC_FILENAME);
    const result = resolveAttachment({
      attachments: [attachment],
      attachmentId: CORRUPTED_ID,
      filename: 'other.zip',
      messageId: 'msg-1',
      log,
      logContext: 'test',
    });

    expect(result).toEqual({
      ok: true,
      attachment,
      resolvedBy: 'sole_attachment',
    });
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
});

describe('formatAttachmentListing', () => {
  it('describes an empty attachment list', () => {
    expect(formatAttachmentListing([])).toBe('Message has no attachments.');
  });

  it('lists filename, size, and id per attachment', () => {
    const listing = formatAttachmentListing([
      att('att-1', 'a.pdf', 10),
      att('att-2', 'b.png', 20),
    ]);
    expect(listing).toContain('filename="a.pdf" size=10 id=att-1');
    expect(listing).toContain('filename="b.png" size=20 id=att-2');
  });
});
