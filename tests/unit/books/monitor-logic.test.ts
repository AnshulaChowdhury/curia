import { describe, it, expect } from 'vitest';
import { decide, lastFire, weekStart, type JobTiming, type MonitorFacts, type RunFact } from '../../../src/books/monitor-logic.js';

const TZ = 'America/Toronto';
const REMINDER: JobTiming = { cronExpr: '0 8 * * 1', timezone: TZ, enabled: true };
const DEADLINE: JobTiming = { cronExpr: '0 12 * * 2', timezone: TZ, enabled: true };
const ACCOUNTS = ['rbc-chequing-4530', 'rbc-mastercard-9956'];

const run = (iso: string, accounts: string[], status: RunFact['status'] = 'ready'): RunFact =>
  ({ receivedAt: new Date(iso), status, accountsReceived: accounts, expectedAccounts: ACCOUNTS });

function facts(nowIso: string, over: Partial<MonitorFacts> = {}): MonitorFacts {
  return {
    now: new Date(nowIso), reminder: REMINDER, deadline: DEADLINE, expectedAccounts: ACCOUNTS,
    recentRuns: [], lastRun: null, heartbeat: null, waitingFiles: null, ...over,
  };
}

// Tuesday 3 Nov 2026 12:00 in Toronto is 17:00Z (EST); Tuesday 27 Oct 12:00 is 16:00Z (EDT, before the clocks go back on 1 Nov).
describe('the clock helpers', () => {
  it('finds the latest fire time, across the daylight-saving change', () => {
    expect(lastFire(DEADLINE, new Date('2026-11-03T17:30:00Z'))?.toISOString()).toBe('2026-11-03T17:00:00.000Z');
    expect(lastFire(DEADLINE, new Date('2026-10-28T10:00:00Z'))?.toISOString()).toBe('2026-10-27T16:00:00.000Z');
    expect(lastFire({ ...DEADLINE, cronExpr: 'nonsense' }, new Date())).toBeNull();
  });
  it('starts the week on Monday 00:00 Toronto time', () => {
    expect(weekStart(new Date('2026-11-03T17:00:00Z'), TZ).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(weekStart(new Date('2026-10-27T16:00:00Z'), TZ).toISOString()).toBe('2026-10-26T04:00:00.000Z');
  });
});

describe('the deadline', () => {
  it('says nothing before the deadline and names the missing accounts after it', () => {
    const lastWeek = run('2026-10-27T10:00:00Z', ACCOUNTS); // the previous week's files, so only the new deadline is in question
    expect(decide(facts('2026-11-03T16:59:00Z', { reminder: null, recentRuns: [lastWeek] }), {})).toEqual([]);
    const [a] = decide(facts('2026-11-03T17:00:00Z', { reminder: null, recentRuns: [run('2026-11-02T15:00:00Z', [ACCOUNTS[0]!])] }), {});
    expect(a?.key).toBe('deadline');
    expect(a?.message).toContain('rbc-mastercard-9956');
    expect(a?.message).not.toContain('rbc-chequing-4530');
  });

  it('follows the clock change: 16:30Z is still before noon in Toronto on 3 Nov (EST) but after noon on 27 Oct (EDT)', () => {
    const earlier = run('2026-10-27T10:00:00Z', ACCOUNTS);
    expect(decide(facts('2026-11-03T16:30:00Z', { reminder: null, recentRuns: [earlier] }), {})).toEqual([]);
    expect(decide(facts('2026-11-03T17:01:00Z', { reminder: null, recentRuns: [] }), {})).toHaveLength(1);
    expect(decide(facts('2026-10-27T16:30:00Z', { reminder: null }), {})).toHaveLength(1);
  });

  it('counts a file from Monday 00:00 Toronto but not from just before', () => {
    const base = { reminder: null };
    const justIn = run('2026-11-02T05:00:00Z', ACCOUNTS);
    const justBefore = run('2026-11-02T04:59:00Z', ACCOUNTS);
    expect(decide(facts('2026-11-03T17:05:00Z', { ...base, recentRuns: [justIn] }), {})).toEqual([]);
    // recentRuns is already limited to the week by the caller, so the boundary is the caller's; the helper agrees on where it is
    expect(justBefore.receivedAt < weekStart(new Date('2026-11-03T17:00:00Z'), TZ)).toBe(true);
  });

  it('is announced once, then repeats daily, and stops when the files arrive', () => {
    const base = { reminder: null };
    const [first] = decide(facts('2026-11-03T17:05:00Z', base), {});
    const state = { deadline: first!.marker };
    expect(decide(facts('2026-11-03T17:20:00Z', base), state)).toEqual([]);
    expect(decide(facts('2026-11-04T17:04:00Z', base), state)).toEqual([]);
    expect(decide(facts('2026-11-04T17:06:00Z', base), state)).toHaveLength(1);
    expect(decide(facts('2026-11-04T17:06:00Z', { ...base, recentRuns: [run('2026-11-04T12:00:00Z', ACCOUNTS)] }), state)).toEqual([]);
  });

  it('is off when the job is paused, and never fires for a deferred run (usage limit)', () => {
    expect(decide(facts('2026-11-03T17:05:00Z', { reminder: null, deadline: { ...DEADLINE, enabled: false } }), {})).toEqual([]);
    const deferred = run('2026-11-03T15:00:00Z', [], 'deferred');
    expect(decide(facts('2026-11-03T17:05:00Z', { reminder: null, lastRun: deferred, recentRuns: [deferred] }), {})).toEqual([]);
  });

  it('cannot fire when no run has ever named the expected accounts', () => {
    expect(decide(facts('2026-11-03T17:05:00Z', { reminder: null, expectedAccounts: [] }), {})).toEqual([]);
  });
});

describe('the Monday reminder', () => {
  it('fires once after its time, listing what is still needed', () => {
    const a = decide(facts('2026-11-02T13:10:00Z'), {}).find(x => x.key === 'reminder');
    expect(a).toMatchObject({ key: 'reminder', title: 'Books: files due' });
    expect(a?.silent).toBeFalsy();
    expect(a?.message).toContain('Tue 3 Nov, 12:00');
    expect(decide(facts('2026-11-02T13:25:00Z', { deadline: null }), { reminder: a!.marker })).toEqual([]);
  });
  it('is recorded but not sent when everything has already arrived, and is not sent days late', () => {
    const [a] = decide(facts('2026-11-02T13:10:00Z', { deadline: null, recentRuns: [run('2026-11-02T13:05:00Z', ACCOUNTS)] }), {});
    expect(a?.silent).toBe(true);
    expect(decide(facts('2026-11-04T09:00:00Z', { deadline: null }), {})).toEqual([]);
  });
});

describe('a file nobody processed', () => {
  const waiting = (iso: string) => [{ id: 'f1', modifiedTime: new Date(iso) }];
  it('alerts after an hour with no run since', () => {
    expect(decide(facts('2026-11-02T14:00:00Z', { reminder: null, deadline: null, waitingFiles: waiting('2026-11-02T13:01:00Z') }), {})).toEqual([]);
    const [a] = decide(facts('2026-11-02T14:02:00Z', { reminder: null, deadline: null, waitingFiles: waiting('2026-11-02T13:01:00Z') }), {});
    expect(a?.key).toBe('unprocessed');
    expect(a?.message).not.toMatch(/f1/);
  });
  it('does not alert when a run came after the file, when the folder is unknown, or while deferred', () => {
    const w = waiting('2026-11-02T13:01:00Z');
    const after = run('2026-11-02T13:30:00Z', ACCOUNTS);
    expect(decide(facts('2026-11-02T15:00:00Z', { reminder: null, deadline: null, waitingFiles: w, lastRun: after }), {})).toEqual([]);
    expect(decide(facts('2026-11-02T15:00:00Z', { reminder: null, deadline: null, waitingFiles: null }), {})).toEqual([]);
    const deferred = run('2026-11-02T13:30:00Z', [], 'deferred');
    expect(decide(facts('2026-11-02T15:00:00Z', { reminder: null, deadline: null, waitingFiles: w, lastRun: deferred }), {})).toEqual([]);
  });
});

describe('a silent Mac mini', () => {
  const hb = (iso: string) => ({ lastSeenAt: new Date(iso), state: 'idle' });
  const only = { reminder: null, deadline: null };
  it('alerts after 60 minutes of silence, and only once it has ever checked in', () => {
    expect(decide(facts('2026-11-02T13:59:00Z', { ...only, heartbeat: hb('2026-11-02T13:00:00Z') }), {})).toEqual([]);
    const [a] = decide(facts('2026-11-02T14:00:00Z', { ...only, heartbeat: hb('2026-11-02T13:00:00Z') }), {});
    expect(a?.key).toBe('silent');
    expect(decide(facts('2026-11-02T14:00:00Z', { ...only, heartbeat: null }), {})).toEqual([]);
  });
  it('repeats after a day, and again for a new outage', () => {
    const [a] = decide(facts('2026-11-02T14:00:00Z', { ...only, heartbeat: hb('2026-11-02T13:00:00Z') }), {});
    const state = { silent: a!.marker };
    expect(decide(facts('2026-11-02T20:00:00Z', { ...only, heartbeat: hb('2026-11-02T13:00:00Z') }), state)).toEqual([]);
    expect(decide(facts('2026-11-03T14:01:00Z', { ...only, heartbeat: hb('2026-11-02T13:00:00Z') }), state)).toHaveLength(1);
    expect(decide(facts('2026-11-05T01:00:00Z', { ...only, heartbeat: hb('2026-11-05T00:00:00Z') }), state)).toHaveLength(1);
  });
});

describe('what the messages say', () => {
  it('never carries amounts, dollar signs or file names', () => {
    const all = [
      ...decide(facts('2026-11-02T13:10:00Z'), {}),
      ...decide(facts('2026-11-03T17:05:00Z', { reminder: null, waitingFiles: [{ id: 'secret-file-id', modifiedTime: new Date('2026-11-03T10:00:00Z') }], heartbeat: { lastSeenAt: new Date('2026-11-03T10:00:00Z'), state: null } }), {}),
    ];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const a of all) expect(`${a.title} ${a.message}`).not.toMatch(/\$|\d+\.\d{2}\b|secret-file-id|\.qbo/i);
  });
});
