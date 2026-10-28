// disclosure-decisions.test.ts — the principal's yes or no on a PII ask (#2312).
//
// SQL shape and normalization against a mock pool. "Latest per (counterparty, label)" is a
// DISTINCT ON query, so its semantics run on Postgres in tests/integration/disclosure-decisions.test.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  DisclosureDecisionRecorder,
  DisclosureDecisionsRepo,
  normalizeCounterparty,
  readDisclosureAsk,
  type DisclosureAsk,
} from '../../../src/autonomy/disclosure-decisions.js';
import type { DbPool } from '../../../src/db/connection.js';
import { createSilentLogger } from '../../../src/logger.js';

function mockPool(rows: Array<Record<string, unknown>> = []) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { pool: { query } as unknown as DbPool, query };
}

const ASK: DisclosureAsk = {
  conversationId: 'conv-T',
  counterparties: ['bookings@acme.example', 'ops@acme.example'],
  labels: ['phone_us', 'sin_ca'],
  requester: 'bookings@acme.example',
};

describe('normalizeCounterparty', () => {
  it('lowercases and trims, and takes the address out of a display-name form', () => {
    expect(normalizeCounterparty('  Bookings@Acme.Example ')).toBe('bookings@acme.example');
    expect(normalizeCounterparty('Acme Bookings <Bookings@Acme.Example>')).toBe('bookings@acme.example');
    expect(normalizeCounterparty('+1 415 555 0100')).toBe('+1 415 555 0100');
  });
});

describe('readDisclosureAsk', () => {
  it('reads a well-formed ask, lowercasing counterparties', () => {
    expect(readDisclosureAsk({ ...ASK, counterparties: ['Bookings@Acme.example'], outreachId: 'o-1' })).toEqual({
      ...ASK, counterparties: ['bookings@acme.example'], outreachId: 'o-1',
    });
  });

  it('keeps a requester name as display text only, and drops a malformed one', () => {
    expect(readDisclosureAsk({ ...ASK, requesterName: ' Dana\n<Whitfield> ' })).toEqual({ ...ASK, requesterName: 'Dana Whitfield' });
    expect(readDisclosureAsk({ ...ASK, requesterName: 7 })).toEqual(ASK);
    expect(readDisclosureAsk({ ...ASK, requesterName: '<>' })).toEqual(ASK);
  });

  it('reads null, and anything malformed, as no ask', () => {
    const bad: unknown[] = [
      null, undefined, 'x', [], {},
      { ...ASK, conversationId: '' },
      { ...ASK, counterparties: [] },
      { ...ASK, counterparties: [1] },
      { ...ASK, labels: [] },
      { ...ASK, labels: 'phone_us' },
      { ...ASK, requester: 7 },
      { ...ASK, outreachId: 3 },
    ];
    for (const raw of bad) expect(readDisclosureAsk(raw)).toBeNull();
  });
});

describe('DisclosureDecisionsRepo', () => {
  it('records one row per decision, with its resolver, counterparties lowercased', async () => {
    const { pool, query } = mockPool();
    await new DisclosureDecisionsRepo(pool).record([
      { conversationId: 'conv-T', counterparty: 'Bookings@Acme.example', label: 'phone_us', decision: 'yes', decidedBy: 'principal_reaction', actionRef: 'ab12cd34' },
      { conversationId: 'conv-T', counterparty: 'ops@acme.example', label: 'phone_us', decision: 'yes', decidedBy: 'principal_via_coordinator' },
    ]);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO disclosure_decisions');
    expect(params).toEqual([
      ['conv-T', 'conv-T'],
      ['bookings@acme.example', 'ops@acme.example'],
      ['phone_us', 'phone_us'],
      ['yes', 'yes'],
      ['principal_reaction', 'principal_via_coordinator'],
      ['ab12cd34', null],
    ]);
  });

  it('records nothing for an empty list', async () => {
    const { pool, query } = mockPool();
    await new DisclosureDecisionsRepo(pool).record([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the latest decision per counterparty and label for the thread and the given counterparties', async () => {
    const { pool, query } = mockPool([{ counterparty: 'bookings@acme.example', label: 'phone_us', decision: 'no' }]);
    const got = await new DisclosureDecisionsRepo(pool).latestFor('conv-T', ['Bookings@Acme.example']);
    expect(got).toEqual([{ counterparty: 'bookings@acme.example', label: 'phone_us', decision: 'no' }]);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('DISTINCT ON (counterparty, label)');
    expect(sql).toContain('created_at DESC');
    expect(params).toEqual(['conv-T', ['bookings@acme.example']]);
  });

  it('reads nothing when there are no counterparties, and drops a row with an unknown decision', async () => {
    const empty = mockPool();
    expect(await new DisclosureDecisionsRepo(empty.pool).latestFor('conv-T', [])).toEqual([]);
    expect(empty.query).not.toHaveBeenCalled();
    const odd = mockPool([{ counterparty: 'a@b.example', label: 'phone_us', decision: 'maybe' }]);
    expect(await new DisclosureDecisionsRepo(odd.pool).latestFor('conv-T', ['a@b.example'])).toEqual([]);
  });
});

describe('DisclosureDecisionRecorder', () => {
  function make(opts: { recordFails?: boolean; learnFails?: boolean; noOutreachRepo?: boolean } = {}) {
    const repo = {
      record: vi.fn(async (_rows: ReadonlyArray<{ decision: string; decidedBy: string }>): Promise<void> => {
        if (opts.recordFails) throw new Error('db down');
      }),
    };
    const taskOutreachRepo = {
      learnCounterparty: vi.fn(opts.learnFails ? async () => { throw new Error('db down'); } : async () => undefined),
    };
    const logger = createSilentLogger();
    const error = vi.spyOn(logger, 'error');
    const recorder = new DisclosureDecisionRecorder({
      repo, ...(opts.noOutreachRepo ? {} : { taskOutreachRepo }), logger,
    });
    return { recorder, repo, taskOutreachRepo, error };
  }
  const row = (disclosureAsk: DisclosureAsk | null | undefined) => ({ id: 7, shortRef: 'ab12cd34', disclosureAsk });

  it('records yes for each counterparty and label of the ask, with the resolver and the approval ref', async () => {
    const { recorder, repo } = make();
    await recorder.recordForApproval(row(ASK), 'yes', 'principal_via_coordinator');
    const by = { decidedBy: 'principal_via_coordinator', actionRef: 'ab12cd34' };
    expect(repo.record).toHaveBeenCalledWith([
      { conversationId: 'conv-T', counterparty: 'bookings@acme.example', label: 'phone_us', decision: 'yes', ...by },
      { conversationId: 'conv-T', counterparty: 'bookings@acme.example', label: 'sin_ca', decision: 'yes', ...by },
      { conversationId: 'conv-T', counterparty: 'ops@acme.example', label: 'phone_us', decision: 'yes', ...by },
      { conversationId: 'conv-T', counterparty: 'ops@acme.example', label: 'sin_ca', decision: 'yes', ...by },
    ]);
    const reaction = make();
    await reaction.recorder.recordForApproval(row(ASK), 'no', 'principal_reaction');
    expect(reaction.repo.record.mock.calls[0]![0].every((r) => r.decidedBy === 'principal_reaction')).toBe(true);
  });

  it('learns the requester onto the linked outreach row on a yes, never on a no', async () => {
    const yes = make();
    await yes.recorder.recordForApproval(row({ ...ASK, outreachId: 'o-1' }), 'yes', 'principal_via_coordinator');
    expect(yes.taskOutreachRepo.learnCounterparty).toHaveBeenCalledExactlyOnceWith('o-1', { address: 'bookings@acme.example' });

    const no = make();
    await no.recorder.recordForApproval(row({ ...ASK, outreachId: 'o-1' }), 'no', 'principal_via_coordinator');
    expect(no.repo.record.mock.calls[0]![0].every((r) => r.decision === 'no')).toBe(true);
    expect(no.taskOutreachRepo.learnCounterparty).not.toHaveBeenCalled();

    const unlinked = make();
    await unlinked.recorder.recordForApproval(row(ASK), 'yes', 'principal_via_coordinator');
    expect(unlinked.taskOutreachRepo.learnCounterparty).not.toHaveBeenCalled();
  });

  it('records nothing for a row without an ask', async () => {
    for (const ask of [null, undefined]) {
      const { recorder, repo, taskOutreachRepo } = make();
      await recorder.recordForApproval(row(ask), 'yes', 'principal_via_coordinator');
      expect(repo.record).not.toHaveBeenCalled();
      expect(taskOutreachRepo.learnCounterparty).not.toHaveBeenCalled();
    }
  });

  it('never throws: a failed write or learn is logged, by labels and ids only', async () => {
    const failing = make({ recordFails: true, learnFails: true });
    await expect(failing.recorder.recordForApproval(row({ ...ASK, outreachId: 'o-1' }), 'yes', 'principal_via_coordinator')).resolves.toBeUndefined();
    expect(failing.error).toHaveBeenCalledTimes(2);
    // The learn still runs when the record failed: they are independent.
    expect(failing.taskOutreachRepo.learnCounterparty).toHaveBeenCalledOnce();

    const noRepo = make({ noOutreachRepo: true });
    await expect(noRepo.recorder.recordForApproval(row({ ...ASK, outreachId: 'o-1' }), 'yes', 'principal_via_coordinator')).resolves.toBeUndefined();
  });
});
