import { describe, it, expect } from 'vitest';
import { deriveEmailReplyRecipientSet } from '../../../../src/channels/email/reply-recipients.js';

describe('deriveEmailReplyRecipientSet', () => {
  const original = {
    originalFrom: 'alice@example.com',
    originalTo: [{ email: 'curia@example.com' }, { email: 'bob@example.com' }],
    originalCc: [{ email: 'carol@example.com' }],
    selfEmails: ['curia@example.com'],
  };

  it('returns null when originalFrom is missing', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      originalFrom: undefined,
      ccInput: undefined,
    })).toBeNull();
  });

  it('returns null when cc is a non-string (fail closed)', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: ['bob@example.com'],
    })).toBeNull();
  });

  it('reply-all (cc omitted) keeps the other To on To and the CC on CC, minus self (#2273)', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: undefined,
    })).toEqual({
      to: 'alice@example.com',
      additionalTo: ['bob@example.com'],
      cc: ['carol@example.com'],
      toIsOriginalSender: true,
    });
  });

  it('sender-only (cc === "") replies to the sender alone', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: '',
    })).toEqual({
      to: 'alice@example.com',
      additionalTo: [],
      cc: [],
      toIsOriginalSender: true,
    });
  });

  it('explicit CC list is parsed as-is, with the sender as To', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: 'a@example.com, b@example.com',
    })).toEqual({
      to: 'alice@example.com',
      additionalTo: [],
      cc: ['a@example.com', 'b@example.com'],
      toIsOriginalSender: true,
    });
  });

  it('reply-all dedupes case-insensitively across fields and preserves first-seen order', () => {
    expect(deriveEmailReplyRecipientSet({
      originalFrom: 'alice@example.com',
      originalTo: [{ email: 'Bob@example.com' }, { email: 'bob@example.com' }, { email: 'ALICE@example.com' }],
      originalCc: [{ email: 'BOB@example.com' }, { email: 'carol@example.com' }],
      ccInput: undefined,
    })).toEqual({
      to: 'alice@example.com',
      additionalTo: ['Bob@example.com'],
      cc: ['carol@example.com'],
      toIsOriginalSender: true,
    });
  });

  it('reply-all excludes every owned mailbox, plus-aliases included', () => {
    expect(deriveEmailReplyRecipientSet({
      originalFrom: 'alice@example.com',
      originalTo: [{ email: 'ops@example.com' }, { email: 'bob@example.com' }],
      originalCc: [{ email: 'Curia+alerts@example.com' }],
      ccInput: undefined,
      selfEmails: ['curia@example.com', 'ops@example.com'],
    })).toEqual({
      to: 'alice@example.com',
      additionalTo: ['bob@example.com'],
      cc: [],
      toIsOriginalSender: true,
    });
  });

  describe('original sent from an owned mailbox (#2273)', () => {
    const ours = {
      originalFrom: 'Curia+alerts@example.com',
      originalTo: [{ email: 'curia@example.com' }, { email: 'boss@example.com' }, { email: 'bob@example.com' }],
      originalCc: [{ email: 'carol@example.com' }, { email: 'ops@example.com' }],
      selfEmails: ['curia@example.com', 'ops@example.com'],
    };

    it('reply-all keeps every non-owned To on To and the CC on CC', () => {
      expect(deriveEmailReplyRecipientSet({ ...ours, ccInput: undefined })).toEqual({
        to: 'boss@example.com',
        additionalTo: ['bob@example.com'],
        cc: ['carol@example.com'],
        toIsOriginalSender: false,
      });
    });

    it('sender-only replies to everyone the original was addressed to, without CC', () => {
      expect(deriveEmailReplyRecipientSet({ ...ours, ccInput: '' })).toEqual({
        to: 'boss@example.com',
        additionalTo: ['bob@example.com'],
        cc: [],
        toIsOriginalSender: false,
      });
    });

    it('falls back to the CC\'d people when the original To held only owned mailboxes', () => {
      expect(deriveEmailReplyRecipientSet({
        ...ours,
        originalTo: [{ email: 'ops@example.com' }],
        originalCc: [{ email: 'carol@example.com' }, { email: 'dave@example.com' }],
        ccInput: undefined,
      })).toEqual({
        to: 'carol@example.com',
        additionalTo: ['dave@example.com'],
        cc: [],
        toIsOriginalSender: false,
      });
    });

    it('returns null when no recipient outside the owned mailboxes remains', () => {
      expect(deriveEmailReplyRecipientSet({
        ...ours,
        originalTo: [{ email: 'ops@example.com' }],
        originalCc: [{ email: 'curia+x@example.com' }],
        ccInput: undefined,
      })).toBeNull();
    });
  });
});
