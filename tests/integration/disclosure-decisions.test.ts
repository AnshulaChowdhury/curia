// tests/integration/disclosure-decisions.test.ts
//
// The principal's yes or no on a personal-data ask (#2312) against real Postgres: "latest per
// (counterparty, label)" is a DISTINCT ON query, and the scoping by thread and counterparty is
// SQL a mock cannot show. Also the ask's round trip through autonomy_action_log.disclosure_ask,
// beside (never inside) the replayed payload, and the recorder end to end.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DisclosureDecisionRecorder, DisclosureDecisionsRepo } from '../../src/autonomy/disclosure-decisions.js';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('disclosure_decisions', () => {
  let pool: pg.Pool;
  let repo: DisclosureDecisionsRepo;
  let dbVerified = false;
  // Fresh per run: the shared test DB carries other suites' rows.
  const run = randomUUID().slice(0, 8);
  const T = `${run}-thread-T`;
  const U = `${run}-thread-U`;
  const BOOKINGS = 'bookings@acme.example';
  const actionIds: number[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    await pool.query('SELECT id FROM disclosure_decisions LIMIT 0');
    repo = new DisclosureDecisionsRepo(pool);
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query('DELETE FROM disclosure_decisions WHERE conversation_id LIKE $1', [`${run}-%`]);
      if (actionIds.length > 0) await pool.query('DELETE FROM autonomy_action_log WHERE id = ANY($1::bigint[])', [actionIds]);
    }
    await pool.end();
  });

  // Review Focus 1: a yes for phone_us to bookings@ on T authorizes nothing else.
  it('scopes a yes to exactly (thread, counterparty, label)', async () => {
    await repo.record([{ conversationId: T, counterparty: 'Bookings@Acme.example', label: 'phone_us', decision: 'yes', actionRef: 'ab12cd34' }]);

    expect(await repo.latestFor(T, [BOOKINGS])).toEqual([{ counterparty: BOOKINGS, label: 'phone_us', decision: 'yes' }]);
    // Another counterparty on T, and the same counterparty on thread U, have nothing.
    expect(await repo.latestFor(T, ['ops@acme.example'])).toEqual([]);
    expect(await repo.latestFor(U, [BOOKINGS])).toEqual([]);
    // sin_ca was never answered: only phone_us comes back.
    expect((await repo.latestFor(T, [BOOKINGS])).map((d) => d.label)).toEqual(['phone_us']);

    const { rows } = await pool.query('SELECT decided_by, action_ref FROM disclosure_decisions WHERE conversation_id = $1', [T]);
    expect(rows).toEqual([{ decided_by: 'principal', action_ref: 'ab12cd34' }]);
  });

  it('returns the latest decision per counterparty and label', async () => {
    const V = `${run}-thread-V`;
    await repo.record([{ conversationId: V, counterparty: BOOKINGS, label: 'phone_us', decision: 'yes' }]);
    await repo.record([
      { conversationId: V, counterparty: BOOKINGS, label: 'phone_us', decision: 'no' },
      { conversationId: V, counterparty: BOOKINGS, label: 'sin_ca', decision: 'yes' },
      { conversationId: V, counterparty: 'ops@acme.example', label: 'phone_us', decision: 'yes' },
    ]);
    const latest = await repo.latestFor(V, [BOOKINGS, 'OPS@acme.example']);
    expect(latest).toHaveLength(3);
    expect(latest).toEqual(expect.arrayContaining([
      { counterparty: BOOKINGS, label: 'phone_us', decision: 'no' },
      { counterparty: BOOKINGS, label: 'sin_ca', decision: 'yes' },
      { counterparty: 'ops@acme.example', label: 'phone_us', decision: 'yes' },
    ]));
    // A later yes overrides the no.
    await repo.record([{ conversationId: V, counterparty: BOOKINGS, label: 'phone_us', decision: 'yes' }]);
    expect(await repo.latestFor(V, [BOOKINGS])).toEqual(expect.arrayContaining([{ counterparty: BOOKINGS, label: 'phone_us', decision: 'yes' }]));
  });

  it('refuses a decision other than yes or no', async () => {
    await expect(pool.query(
      `INSERT INTO disclosure_decisions (conversation_id, counterparty, label, decision, decided_by) VALUES ($1, 'a', 'b', 'maybe', 'principal')`,
      [`${run}-bad`],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('stores an approval\'s ask beside its payload, and the recorder writes the answer from it', async () => {
    const actionLog = new ActionLogRepo(pool, createSilentLogger());
    const W = `${run}-thread-W`;
    const ask = { conversationId: W, counterparties: [BOOKINGS], labels: ['phone_us'], requester: BOOKINGS };
    const payload = { recipient_contact_id: randomUUID(), subject: 'Booking', body: 'Call me.' };
    const shortRef = run;
    const id = await actionLog.insert({
      taskId: `${run}-task`, conversationId: W, toolName: 'email-send', actionRisk: 'medium', outcome: 'pending_approval',
      shortRef, description: 'Email to bookings', payload, disclosureAsk: ask, expiresAt: new Date(Date.now() + 3_600_000),
    });
    actionIds.push(id);

    const row = await actionLog.findPendingByShortRef(shortRef);
    expect(row?.disclosureAsk).toEqual(ask);
    // The replayed input is exactly what was held: no ask inside it.
    expect(row?.payload).toEqual(payload);

    await new DisclosureDecisionRecorder({ repo, logger: createSilentLogger() }).recordForApproval(row!, 'no');
    expect(await repo.latestFor(W, [BOOKINGS])).toEqual([{ counterparty: BOOKINGS, label: 'phone_us', decision: 'no' }]);
    const { rows } = await pool.query('SELECT action_ref FROM disclosure_decisions WHERE conversation_id = $1', [W]);
    expect(rows).toEqual([{ action_ref: shortRef }]);
  });
});
