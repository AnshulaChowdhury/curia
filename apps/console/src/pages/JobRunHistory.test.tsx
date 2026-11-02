// @vitest-environment happy-dom
// The run history in the job drawer: the list of runs, a run's steps with inputs, outputs and codes, and its edge cases.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }));

import { JobRunHistory, formatDuration, formatOffset } from './JobRunHistory.js';

const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

const run = (over: Record<string, unknown> = {}) => ({
  runId: 'r1', startedAt: '2026-11-03T13:00:00Z', endedAt: '2026-11-03T13:00:06Z', durationMs: 6200, outcome: 'completed',
  toolCalls: 1, toolFailures: 0, llmCalls: 2, errors: 0, costUsd: 0.0123, ...over,
});

const detail = {
  ...run({ outcome: 'failed', toolFailures: 1 }), cutOff: false,
  steps: [
    { id: 's1', at: '', offsetMs: 0, kind: 'task', title: 'Task given to the agent', status: null, durationMs: null, input: 'go', output: null, codes: [] },
    { id: 's2', at: '', offsetMs: 3400, kind: 'tool', title: 'scheduler-report', status: 'error', durationMs: 250,
      input: { summary: 'x', api_key: '[redacted]' }, output: { error: 'HTTP 401' },
      codes: [{ label: 'error type', value: 'AUTH_FAILURE' }, { label: 'usually', value: 'HTTP 401 or 403', inferred: true }, { label: 'HTTP', value: '401' }] },
  ],
};

let container: HTMLElement;
let root: Root;

async function mount(jobId = 'job-1') {
  await act(async () => { root.render(<JobRunHistory jobId={jobId} />); });
}
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  mocks.apiFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('formatting', () => {
  it('shows durations and offsets plainly', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(6200)).toBe('6.2 s');
    expect(formatDuration(125000)).toBe('2 min 5 s');
    expect(formatOffset(3400)).toBe('+3.4 s');
  });
});

describe('JobRunHistory', () => {
  it('lists the runs with their outcome and counts', async () => {
    mocks.apiFetch.mockImplementation(() => json({ runs: [run(), run({ runId: 'r2', outcome: 'failed', toolFailures: 1, toolCalls: 2 })] }));
    await mount();
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/jobs/job-1/runs', expect.anything());
    const rows = container.querySelectorAll('.run-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('completed');
    expect(rows[0]!.textContent).toContain('1 tool call · 2 model calls');
    expect(rows[0]!.textContent).toContain('$0.0123');
    expect(rows[1]!.textContent).toContain('failed');
    expect(rows[1]!.textContent).toContain('2 tool calls (1 failed)');
  });

  it('says so when a job has not run', async () => {
    mocks.apiFetch.mockImplementation(() => json({ runs: [] }));
    await mount();
    expect(container.textContent).toContain('No runs recorded yet');
  });

  it('says so when the history cannot be loaded', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.apiFetch.mockImplementation(() => json({}, 500));
    await mount();
    expect(container.textContent).toContain('Run history could not be loaded');
    spy.mockRestore();
  });

  it('opens a run to show each step with its input, output and API codes', async () => {
    mocks.apiFetch.mockImplementation((url: string) => json(url.endsWith('/runs/r1') ? { run: detail } : { runs: [run()] }));
    await mount();
    await act(async () => { (container.querySelector('.run-row') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/jobs/job-1/runs/r1');
    const steps = container.querySelectorAll('.run-step');
    expect(steps).toHaveLength(2);
    const failed = steps[1] as HTMLDetailsElement;
    expect(failed.open).toBe(true);                          // a failed step opens by itself
    expect(failed.textContent).toContain('scheduler-report');
    expect(failed.textContent).toContain('error type: AUTH_FAILURE');
    expect(failed.textContent).toContain('HTTP: 401');
    expect(failed.querySelector('.run-code-inferred')?.textContent).toContain('(inferred)');
    const bodies = [...failed.querySelectorAll('.run-io-body')].map(n => n.textContent);
    expect(bodies[0]).toContain('[redacted]');
    expect(bodies[1]).toContain('HTTP 401');
    expect((steps[0] as HTMLDetailsElement).open).toBe(false);
  });

  it('does not refetch a run it already has, and closes it on a second click', async () => {
    mocks.apiFetch.mockImplementation((url: string) => json(url.endsWith('/runs/r1') ? { run: detail } : { runs: [run()] }));
    await mount();
    const click = async () => { await act(async () => { (container.querySelector('.run-row') as HTMLButtonElement).click(); }); await flush(); };
    await click();
    await click();
    expect(container.querySelector('.run-detail')).toBeNull();
    await click();
    expect(mocks.apiFetch.mock.calls.filter(c => String(c[0]).endsWith('/runs/r1'))).toHaveLength(1);
  });

  it('warns when a run was cut off', async () => {
    mocks.apiFetch.mockImplementation((url: string) => json(url.endsWith('/runs/r1') ? { run: { ...detail, cutOff: true } } : { runs: [run()] }));
    await mount();
    await act(async () => { (container.querySelector('.run-row') as HTMLButtonElement).click(); });
    await flush();
    expect(container.textContent).toContain('more steps than are shown');
  });

  it('reloads when the drawer moves to another job', async () => {
    mocks.apiFetch.mockImplementation(() => json({ runs: [] }));
    await mount('job-1');
    await mount('job-2');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/jobs/job-2/runs', expect.anything());
  });
});
