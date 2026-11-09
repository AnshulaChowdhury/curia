import { describe, it, expect, vi } from 'vitest';
import { BooksRunner, RETRY_AFTER_FAILURE_MS, type RunnerDeps } from '../../../src/books/books-runner.js';
import { BooksServiceError, type RunRequest, type RunResponse } from '../../../src/books/books-service-client.js';
import type { Logger } from '../../../src/logger.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const STATE = { processed: ['h'], transactions: [], closing: {} };
const report = (over: Record<string, unknown> = {}) => ({
  status: 'ready' as const, batch_id: 'abcdef12', file_hashes: ['h'], accounts_received: ['chq'],
  counts: { by_rule: 2, guesses: 1, needs_input: 0, flags: 0 }, flags: [], error: null, ...over,
});
const ready = (agent_requests: unknown[] = []): RunResponse => ({
  rules_version: 'v', report: report(),
  batch: { batch_id: 'abcdef12', revision: 1, rows: [{ id: 'r1', amount: '-1.00', date: '2026-10-01', description: 'X' }] },
  agent_input: [], agent_requests: agent_requests as never, state: STATE,
});

function setup(responses: RunResponse[], over: Partial<RunnerDeps> = {}) {
  let clock = 1_000_000;
  const service = {
    run: vi.fn(async (_request: RunRequest) => responses.shift() ?? ready()),
    accounts: vi.fn(async () => [{ id: 'chq', name: 'Chequing', kind: 'bank', qbo_account: 'Chequing' }]),
  };
  const deps = {
    service,
    state: { load: vi.fn(async () => null), save: vi.fn(async () => undefined) },
    uploads: {
      listWaiting: vi.fn(async () => [{ id: 'u1', name: 'secret-name.qbo', size: 1, uploadedAt: '' }]),
      read: vi.fn(async () => ({ name: 'secret-name.qbo', bytes: Buffer.from('OFX') })),
      markProcessed: vi.fn(async () => true),
    },
    drive: { list: vi.fn(async () => []), read: vi.fn(), markProcessed: vi.fn() },
    batches: { upsertBatch: vi.fn(async () => 1) },
    monitorStore: { recordRun: vi.fn(async () => undefined), recordHeartbeat: vi.fn(async () => undefined) },
    monitor: { onRunReported: vi.fn(async () => undefined) },
    qbo: { api: vi.fn(async () => ({ QueryResponse: { Account: [{ Id: '1', Name: 'Chequing' }] } })) },
    llm: { extract: vi.fn(async () => ({ ok: true, text: '{"rows":[]}' })) },
    logger,
    now: () => new Date(clock),
    ...over,
  } as unknown as RunnerDeps;
  return { runner: new BooksRunner(deps), deps, service, advance: (ms: number) => { clock += ms; } };
}

describe('BooksRunner', () => {
  it('does nothing when no files are waiting', async () => {
    const { runner, service } = setup([], { uploads: { listWaiting: async () => [], read: vi.fn(), markProcessed: vi.fn() } } as never);
    expect(await runner.runOnce('manual')).toEqual({ outcome: 'nothing_waiting' });
    expect(service.run).not.toHaveBeenCalled();
  });

  it('stores the batch, saves state, then marks files processed', async () => {
    const { runner, deps, service } = setup([ready()]);
    const out = await runner.runOnce('manual');
    expect(out).toMatchObject({ outcome: 'ready', rows: 1, byRule: 2, guesses: 1, files: 1 });
    const sent = service.run.mock.calls[0]![0];
    expect(sent.files[0]!.name).toBe('file-1.qbo'); // the real file name never leaves Curia
    expect(deps.batches.upsertBatch).toHaveBeenCalledOnce();
    expect(deps.state.save).toHaveBeenCalledWith(STATE);
    expect(deps.uploads.markProcessed).toHaveBeenCalledWith('u1');
  });

  it('reads QuickBooks and asks the model when the service asks', async () => {
    const req = { rows: ['r1'], system: 's', user: 'u', schema: '{}' };
    const { runner, service, deps } = setup([
      { rules_version: 'v', need_qbo: { start: '2026-09-01', end: '2026-11-01' } },
      ready([req]),
      ready(),
    ]);
    expect((await runner.runOnce('manual')).outcome).toBe('ready');
    expect(service.run).toHaveBeenCalledTimes(3);
    expect(deps.llm.extract).toHaveBeenCalledOnce();
    const third = service.run.mock.calls[2]![0];
    expect(third.agent?.status).toBe('ok');
    expect(third.qbo_lines).toEqual([]);
  });

  it('still completes when the model fails, leaving those lines for the owner', async () => {
    const req = { rows: ['r1'], system: 's', user: 'u', schema: '{}' };
    const { runner, service } = setup([ready([req]), ready()], { llm: { extract: vi.fn(async () => ({ ok: false, error: 'down' })) } } as never);
    expect((await runner.runOnce('manual')).outcome).toBe('ready');
    expect(service.run.mock.calls[1]![0].agent?.status).toBe('error');
  });

  it('stops without marking files when QuickBooks cannot be read', async () => {
    const { runner, deps } = setup(
      [{ rules_version: 'v', need_qbo: { start: '2026-09-01', end: '2026-11-01' } }],
      { qbo: { api: vi.fn(async () => { throw new Error('401'); }) } } as never,
    );
    const out = await runner.runOnce('manual');
    expect(out).toMatchObject({ outcome: 'failed' });
    expect(deps.uploads.markProcessed).not.toHaveBeenCalled();
    expect(deps.monitor.onRunReported).toHaveBeenCalledOnce();
  });

  it('records a failed run when the service is down, and pauses scheduled retries for an hour', async () => {
    const { runner, deps, service, advance } = setup([]);
    service.run.mockRejectedValue(new BooksServiceError('unreachable', 'The books service could not be reached'));
    expect(await runner.runOnce('schedule')).toMatchObject({ outcome: 'failed' });
    expect(deps.monitor.onRunReported).toHaveBeenCalledOnce();
    expect(deps.uploads.markProcessed).not.toHaveBeenCalled();

    expect(await runner.runOnce('schedule')).toEqual({ outcome: 'nothing_waiting' });
    expect(service.run).toHaveBeenCalledTimes(1);
    expect(await runner.runOnce('manual')).toMatchObject({ outcome: 'failed' }); // a person can always retry
    advance(RETRY_AFTER_FAILURE_MS + 1);
    await runner.runOnce('schedule');
    expect(service.run).toHaveBeenCalledTimes(3);
  });

  it('refuses a second run while one is in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { runner } = setup([ready()], { state: { load: async () => { await gate; return null; }, save: vi.fn() } } as never);
    const first = runner.runOnce('manual');
    expect(await runner.runOnce('manual')).toEqual({ outcome: 'already_running' });
    release();
    expect((await first).outcome).toBe('ready');
  });
});
