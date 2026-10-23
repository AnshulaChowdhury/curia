import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessages, mockFolders, sdkConfigs } = vi.hoisted(() => ({
  mockMessages: { list: vi.fn() },
  mockFolders: { list: vi.fn() },
  sdkConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
    folders = mockFolders;
    constructor(config: Record<string, unknown>) {
      sdkConfigs.push(config);
    }
  }
  return { default: MockNylas };
});

import pino from 'pino';
import { NylasClient } from '../../../src/channels/email/nylas-client.js';
import { NylasPrincipalMailbox } from '../../../src/contacts/nylas-principal-mailbox.js';

const logger = pino({ level: 'silent' });

function sent(to: string[]) {
  return { id: 'm1', to: to.map((email) => ({ email })), cc: [], from: [], date: 0 };
}

// An Outlook-shaped folder list: the Sent folder's id and name are not Gmail's SENT.
const OUTLOOK_FOLDERS = [
  { id: 'AAMkInbox', name: 'Inbox', attributes: ['\\Inbox'] },
  { id: 'AAMkSentItems', name: 'Sent Items', attributes: ['\\Sent'] },
  { id: 'AAMkProjects', name: 'Projects' },
];

describe('NylasPrincipalMailbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkConfigs.length = 0;
    mockFolders.list.mockResolvedValue({ data: OUTLOOK_FOLDERS });
  });

  // The race returns at the deadline but cannot cancel the request; the SDK timeout does.
  it('builds its client with the lookup deadline as the SDK timeout, in seconds', () => {
    new NylasPrincipalMailbox('api-key', 'grant-id', logger);
    expect(sdkConfigs).toEqual([{ apiKey: 'api-key', timeout: 5 }]);
  });

  it('leaves the SDK default timeout on clients built without one', () => {
    new NylasClient('api-key', 'grant-id', logger);
    expect(sdkConfigs).toEqual([{ apiKey: 'api-key' }]);
  });

  it('searches the folder marked \\Sent with any_email, not a Gmail-only native query', async () => {
    mockMessages.list.mockResolvedValue({ data: [sent(['Dana@Example.test'])] });
    const mailbox = new NylasPrincipalMailbox('api-key', 'grant-id', logger);
    await expect(mailbox.hasSentTo('dana@example.test')).resolves.toBe(true);
    const { queryParams } = mockMessages.list.mock.calls[0]![0] as { queryParams: Record<string, unknown> };
    expect(queryParams).toEqual(expect.objectContaining({ in: ['AAMkSentItems'], anyEmail: ['dana@example.test'], limit: 5 }));
    expect(queryParams).not.toHaveProperty('searchQueryNative');
  });

  it('reads a hit without the address among its recipients as no correspondence', async () => {
    mockMessages.list.mockResolvedValue({ data: [sent(['someone-else@example.test'])] });
    const mailbox = new NylasPrincipalMailbox('api-key', 'grant-id', logger);
    await expect(mailbox.hasSentTo('dana@example.test')).resolves.toBe(false);
  });

  it('throws, rather than answering no, when no folder is marked \\Sent', async () => {
    mockFolders.list.mockResolvedValue({ data: [{ id: 'INBOX', name: 'INBOX' }] });
    const mailbox = new NylasPrincipalMailbox('api-key', 'grant-id', logger);
    await expect(mailbox.hasSentTo('dana@example.test')).rejects.toThrow(/\\Sent/);
    expect(mockMessages.list).not.toHaveBeenCalled();
  });

  it('rejects at the deadline when the request hangs', async () => {
    mockMessages.list.mockReturnValue(new Promise(() => {}));
    const mailbox = new NylasPrincipalMailbox('api-key', 'grant-id', logger, 20);
    await expect(mailbox.hasSentTo('dana@example.test')).rejects.toThrow(/timed out after 20ms/);
  });
});
