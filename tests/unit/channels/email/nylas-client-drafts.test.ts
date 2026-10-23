import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessages, mockDrafts } = vi.hoisted(() => {
  const mockMessages = { list: vi.fn(), find: vi.fn(), send: vi.fn(), update: vi.fn() };
  const mockDrafts = { create: vi.fn(), list: vi.fn(), find: vi.fn(), send: vi.fn() };
  return { mockMessages, mockDrafts };
});

vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
    drafts = mockDrafts;
  }
  return { default: MockNylas };
});

import { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const SDK_DRAFT = {
  id: 'r956985379676630908',
  threadId: 't-1',
  subject: 'The Room Full of Money - refresh done',
  to: [{ email: 'joseph@example.com' }],
  body: '<p>Refresh is complete.</p>',
  date: 1792761567,
  folders: ['DRAFT'],
};

// The SDK's error shape: Gmail's answer to `in=DRAFTS` was a NylasApiError with statusCode 400.
function nylasError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

describe('NylasClient drafts (#2262)', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('api-key', 'grant-id', logger);
    mockMessages.list.mockResolvedValue({ data: [], requestId: 'req-1' });
    mockDrafts.list.mockResolvedValue({ data: [SDK_DRAFT], requestId: 'req-2' });
  });

  describe('listMessages with a drafts folder', () => {
    it.each(['DRAFTS', 'DRAFT', 'drafts'])('reads /drafts, not /messages?in=…, for folder %s', async (folder) => {
      const result = await client.listMessages({ folders: [folder], limit: 10 });

      expect(mockMessages.list).not.toHaveBeenCalled();
      expect(mockDrafts.list).toHaveBeenCalledWith({ identifier: 'grant-id', queryParams: { limit: 10 } });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('r956985379676630908');
      expect(result[0]!.to).toEqual([{ email: 'joseph@example.com' }]);
    });

    it('keeps other folders on /messages', async () => {
      await client.listMessages({ folders: ['SENT'] });
      expect(mockDrafts.list).not.toHaveBeenCalled();
      expect(mockMessages.list).toHaveBeenCalledWith(
        expect.objectContaining({ queryParams: expect.objectContaining({ in: ['SENT'] }) }),
      );
    });

    it('keeps a native search on /messages (it overrides folders there)', async () => {
      await client.listMessages({ folders: ['DRAFTS'], searchQueryNative: 'in:drafts essay' });
      expect(mockDrafts.list).not.toHaveBeenCalled();
      expect(mockMessages.list).toHaveBeenCalled();
    });
  });

  describe('getDraft', () => {
    it('returns the normalized draft', async () => {
      mockDrafts.find.mockResolvedValue({ data: SDK_DRAFT, requestId: 'req-3' });
      const draft = await client.getDraft('r956985379676630908');
      expect(mockDrafts.find).toHaveBeenCalledWith({ identifier: 'grant-id', draftId: 'r956985379676630908' });
      expect(draft?.subject).toBe('The Room Full of Money - refresh done');
    });

    it('returns null when the mailbox has no such draft (404)', async () => {
      mockDrafts.find.mockRejectedValue(nylasError(404, 'Not Found'));
      await expect(client.getDraft('r-missing')).resolves.toBeNull();
    });

    it('rethrows any other failure', async () => {
      mockDrafts.find.mockRejectedValue(nylasError(500, 'Internal Server Error'));
      await expect(client.getDraft('r956985379676630908')).rejects.toThrow('Internal Server Error');
    });
  });
});
