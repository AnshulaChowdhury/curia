import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessages, sdkConfigs } = vi.hoisted(() => ({
  mockMessages: { list: vi.fn() },
  sdkConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
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

describe('NylasPrincipalMailbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkConfigs.length = 0;
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

  it('finds the address among the recipients of a sent message', async () => {
    mockMessages.list.mockResolvedValue({ data: [sent(['Dana@Example.test'])] });
    const mailbox = new NylasPrincipalMailbox('api-key', 'grant-id', logger);
    await expect(mailbox.hasSentTo('dana@example.test')).resolves.toBe(true);
    expect(mockMessages.list).toHaveBeenCalledWith(expect.objectContaining({
      queryParams: expect.objectContaining({ searchQueryNative: 'in:sent to:dana@example.test', limit: 5 }),
    }));
  });

  it('reads a fuzzy search hit without the address as no correspondence', async () => {
    mockMessages.list.mockResolvedValue({ data: [sent(['someone-else@example.test'])] });
    const mailbox = new NylasPrincipalMailbox('api-key', 'grant-id', logger);
    await expect(mailbox.hasSentTo('dana@example.test')).resolves.toBe(false);
  });

  it('rejects at the deadline when the request hangs', async () => {
    mockMessages.list.mockReturnValue(new Promise(() => {}));
    const mailbox = new NylasPrincipalMailbox('api-key', 'grant-id', logger, 20);
    await expect(mailbox.hasSentTo('dana@example.test')).rejects.toThrow(/timed out after 20ms/);
  });
});
