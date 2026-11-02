import { describe, it, expect } from 'vitest';
import { BooksMonitor } from '../../../src/books/monitor.js';
import type { MonitorStore } from '../../../src/books/monitor-store.js';
import type { BooksNotifier } from '../../../src/books/notifier.js';
import type { JobTiming } from '../../../src/books/monitor-logic.js';
import { createSilentLogger } from '../../../src/logger.js';

const ACCOUNTS = ['rbc-chequing-4530', 'rbc-mastercard-9956'];

function build(opts: { now?: string; token?: boolean; timings?: { reminder?: JobTiming | null; deadline?: JobTiming | null }; waiting?: Array<{ id: string; name: string; size: number; modifiedTime: string; md5: string }> | Error; createFails?: boolean } = {}) {
  const state: Record<string, string> = {};
  const jobs: Array<Record<string, unknown>> = [];
  const sent: Array<{ title: string; message: string }> = [];
  const timings = opts.timings ?? {};
  const store = {
    getState: async () => ({ ...state }),
    setState: async (k: string, v: string) => { state[k] = v; },
    jobTiming: async (kind: 'reminder' | 'deadline') => timings[kind] ?? null,
    expectedAccounts: async () => ACCOUNTS,
    lastRun: async () => null,
    getHeartbeat: async () => null,
    runsSince: async () => [],
  } as unknown as MonitorStore;
  const notifier = { notify: async (title: string, message: string) => { sent.push({ title, message }); return 1; } } as unknown as BooksNotifier;
  const monitor = new BooksMonitor({
    store, notifier, logger: createSilentLogger(),
    now: () => new Date(opts.now ?? '2026-11-03T17:05:00Z'),
    booksToken: { isSet: async () => opts.token ?? true },
    schedulerService: { createJob: async (p: object) => { if (opts.createFails) throw new Error('db down'); jobs.push(p as Record<string, unknown>); return { jobId: String(jobs.length) }; } },
    driveInbox: { list: async () => { if (opts.waiting instanceof Error) throw opts.waiting; return opts.waiting ?? []; } },
  });
  return { monitor, state, jobs, sent };
}

describe('seeding the weekly jobs', () => {
  it('creates the reminder and deadline jobs once, with Toronto timing, created by books', async () => {
    const { monitor, jobs, state } = build();
    expect(await monitor.ensureSeeded()).toBe(true);
    expect(jobs.map(j => [j.cronExpr, j.timezone, j.createdBy, (j.taskPayload as Record<string, string>).books_job])).toEqual([
      ['0 8 * * 1', 'America/Toronto', 'books', 'reminder'],
      ['0 12 * * 2', 'America/Toronto', 'books', 'deadline'],
    ]);
    expect(state['jobs_seeded']).toBeTruthy();
    expect(await monitor.ensureSeeded()).toBe(false);
    expect(jobs).toHaveLength(2); // a second call, or a restart, never recreates them (even if the owner deleted them)
  });
  it('waits until the books feature is set up, and retries after a failure without marking it done', async () => {
    const off = build({ token: false });
    expect(await off.monitor.ensureSeeded()).toBe(false);
    expect(off.jobs).toHaveLength(0);
    const broken = build({ createFails: true });
    expect(await broken.monitor.ensureSeeded()).toBe(false);
    expect(broken.state['jobs_seeded']).toBeUndefined();
  });
  it('asks the coordinator for a harmless checkpoint, not for any notification', async () => {
    const { monitor, jobs } = build();
    await monitor.ensureSeeded();
    const task = (jobs[0]!.taskPayload as Record<string, string>).task!;
    expect(jobs[0]!.agentId).toBe('coordinator');
    expect(task).toMatch(/do not message anyone/);
  });
});

describe('the 15-minute check', () => {
  const DEADLINE = { cronExpr: '0 12 * * 2', timezone: 'America/Toronto', enabled: true };
  it('notifies a missed deadline once, remembers it, and says nothing the next time', async () => {
    const { monitor, sent, state } = build({ timings: { deadline: DEADLINE } });
    await monitor.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Books: files overdue');
    expect(sent[0]!.message).toContain(ACCOUNTS[0]!);
    expect(state['deadline']).toBeTruthy();
    expect(state['last_notified_at']).toBeTruthy();
    await monitor.tick();
    expect(sent).toHaveLength(1);
  });
  it('survives an unreadable Drive folder and still checks the rest', async () => {
    const { monitor, sent } = build({ timings: { deadline: DEADLINE }, waiting: new Error('not configured') });
    await monitor.tick();
    expect(sent).toHaveLength(1);
  });
  it('flags a file left in the folder for over an hour', async () => {
    const { monitor, sent } = build({ now: '2026-11-02T15:00:00Z', waiting: [{ id: 'f1', name: 'w.qbo', size: 1, modifiedTime: '2026-11-02T13:00:00Z', md5: '' }] });
    await monitor.tick();
    expect(sent.map(s => s.title)).toEqual(['Books: file not processed']);
  });
  it('never throws out of the timer', async () => {
    const { monitor } = build();
    await expect(monitor.tick()).resolves.toBeUndefined();
  });
});

describe('a failed run', () => {
  const run = (status: 'ready' | 'failed' | 'deferred') => ({ status, batchId: null, accountsReceived: [], expectedAccounts: [], files: [], report: {} });
  it('is announced at once; ready and deferred runs are not', async () => {
    const { monitor, sent } = build();
    await monitor.onRunReported(run('ready'));
    await monitor.onRunReported(run('deferred'));
    expect(sent).toHaveLength(0);
    await monitor.onRunReported(run('failed'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Books: run failed');
    expect(sent[0]!.message).not.toMatch(/\$|error:/i);
  });
});
