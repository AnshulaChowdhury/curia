import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { DbPool } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';
import { holdInstanceLock } from '../../../src/db/instance-lock.js';

function fakeClient(locked: boolean) {
  return Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [{ locked }] }),
    release: vi.fn(),
  });
}

function fakePool(locked: boolean) {
  const client = fakeClient(locked);
  const holderRow = {
    pid: 4242,
    application_name: 'curia',
    client_addr: '192.0.2.5',
    backend_start: new Date('2026-10-21T10:00:00Z'),
  };
  const pool = {
    connect: vi.fn(() => Promise.resolve(client)),
    query: vi.fn().mockResolvedValue({ rows: [holderRow] }),
  };
  return { pool: pool as unknown as DbPool, client };
}

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

describe('holdInstanceLock', () => {
  it('warns naming the holder and lets boot continue when the lock is taken', async () => {
    const { pool } = fakePool(false);
    const logger = fakeLogger();

    const release = await holdInstanceLock(pool, logger);

    const [fields, message] = logger.warn.mock.calls[0]!;
    expect(fields.holder).toMatchObject({ pid: 4242, applicationName: 'curia' });
    expect(message).toContain('"curia" (pid 4242 from 192.0.2.5');
    await expect(release()).resolves.toBeUndefined();
  });

  it('logs an error telling the operator to restart when the lock connection drops', async () => {
    const { pool, client } = fakePool(true);
    const logger = fakeLogger();
    await holdInstanceLock(pool, logger);

    client.emit('end');

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]![0]).toMatch(/pnpm reembed:kg.*Restart Curia/);
  });

  it('does not treat its own release as a lost connection', async () => {
    const { pool, client } = fakePool(true);
    const logger = fakeLogger();
    const release = await holdInstanceLock(pool, logger);

    await release();
    client.emit('end');

    expect(logger.error).not.toHaveBeenCalled();
  });
});
