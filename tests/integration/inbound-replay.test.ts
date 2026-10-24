// Replay selection for unacknowledged inbound.message rows (#2254).
// Requires Postgres. Skipped when DATABASE_URL is unset.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { AuditLogger } from '../../src/audit/logger.js';
import { createInboundMessage } from '../../src/bus/events.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;

function collectLogs() {
  const entries: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString().trim();
      if (line) entries.push(JSON.parse(line) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), entries };
}

function inbound(accountId: string, nylasMessageId: string, timestamp: Date) {
  const event = createInboundMessage({
    conversationId: `email:thread-${nylasMessageId}`,
    channelId: 'email',
    accountId,
    senderId: 'ada@example.com',
    content: 'hello',
    metadata: { nylasMessageId },
  });
  event.timestamp = timestamp;
  return event;
}

describeIf('listUnacknowledgedInbound replay window (#2254)', () => {
  let pool: pg.Pool;
  let audit: AuditLogger;
  const written: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    audit = new AuditLogger(pool, createSilentLogger());
    await pool.query('SELECT 1 FROM audit_log LIMIT 0');
  });

  afterAll(async () => {
    for (const id of written) {
      try {
        await audit.markAcknowledged(id);
      } catch (err) {
        // The row may already be acknowledged by the case under test.
        // Leaving it unacknowledged would show up in the startup scan.
        const message = err instanceof Error ? err.message : String(err);
        if (!/already/i.test(message)) throw err;
      }
    }
    await pool.end();
  });

  async function write(accountId: string, nylasMessageId: string, timestamp: Date) {
    const event = inbound(accountId, nylasMessageId, timestamp);
    await audit.log(event);
    written.push(event.id);
    return event;
  }

  it('leaves a row older than 24 hours out and warns', async () => {
    const accountId = `replay-old-${randomUUID()}`;
    const { logger, entries } = collectLogs();
    const scoped = new AuditLogger(pool, logger);
    const old = await write(accountId, `old-${accountId}`, new Date(Date.now() - 48 * HOUR_MS));
    const recent = await write(accountId, `recent-${accountId}`, new Date(Date.now() - HOUR_MS));

    const events = await scoped.listUnacknowledgedInbound(accountId);

    expect(events.map((event) => event.id)).toEqual([recent.id]);
    expect(events.map((event) => event.id)).not.toContain(old.id);
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Unacknowledged inbound mail older than the replay window was left out',
      accountId,
      count: 1,
    }));
  });

  it('omits a row when a later row shares its nylas id, acknowledged or not', async () => {
    const accountId = `replay-later-${randomUUID()}`;
    const nylasMessageId = `same-${accountId}`;
    const earlier = await write(accountId, nylasMessageId, new Date(Date.now() - 2 * HOUR_MS));
    const later = await write(accountId, nylasMessageId, new Date(Date.now() - HOUR_MS));

    const whileLaterIsOpen = await audit.listUnacknowledgedInbound(accountId);
    expect(whileLaterIsOpen.map((event) => event.id)).toEqual([later.id]);

    await audit.markAcknowledged(later.id);
    const afterLaterAcknowledged = await audit.listUnacknowledgedInbound(accountId);
    expect(afterLaterAcknowledged.map((event) => event.id)).not.toContain(earlier.id);
    expect(afterLaterAcknowledged.map((event) => event.id)).not.toContain(later.id);
  });

  it('keeps a row when the later duplicate belongs to another account', async () => {
    const accountId = `replay-account-a-${randomUUID()}`;
    const otherAccount = `replay-account-b-${randomUUID()}`;
    const nylasMessageId = `shared-${accountId}`;
    const ours = await write(accountId, nylasMessageId, new Date(Date.now() - 2 * HOUR_MS));
    await write(otherAccount, nylasMessageId, new Date(Date.now() - HOUR_MS));

    const events = await audit.listUnacknowledgedInbound(accountId);
    expect(events.map((event) => event.id)).toEqual([ours.id]);
  });

  it('returns an unacknowledged row that has no later duplicate', async () => {
    const accountId = `replay-only-${randomUUID()}`;
    const only = await write(accountId, `only-${accountId}`, new Date(Date.now() - HOUR_MS));

    const events = await audit.listUnacknowledgedInbound(accountId);

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(only.id);
    expect(events[0]?.payload.metadata).toMatchObject({ nylasMessageId: `only-${accountId}` });
  });
});
