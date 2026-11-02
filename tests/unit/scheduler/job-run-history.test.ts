import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { JobRunHistory, buildSteps, httpCodesIn, scrub, shape } from '../../../src/scheduler/job-run-history.js';

const JOB = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

const row = (id: string, type: string, payload: Record<string, unknown>, at: string, parent: string | null = null) =>
  ({ id, timestamp: new Date(at), event_type: type, payload, parent_event_id: parent });

describe('scrub', () => {
  it('blanks secret-looking fields at any depth and keeps the rest', () => {
    const out = scrub({ to: 'a@b.c', access_token: 'abc', nested: { Authorization: 'Bearer x', apiKey: 'k', ok: 1 }, list: [{ password: 'p' }] });
    expect(out).toEqual({ to: 'a@b.c', access_token: '[redacted]', nested: { Authorization: '[redacted]', apiKey: '[redacted]', ok: 1 }, list: [{ password: '[redacted]' }] });
  });

  it('cuts long strings, long lists and deep nesting', () => {
    expect(String(scrub('x'.repeat(5000)))).toMatch(/1000 more characters/);
    expect((scrub(Array.from({ length: 60 }, (_, i) => i)) as unknown[]).length).toBe(51);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i++) deep = { a: deep };
    expect(JSON.stringify(scrub(deep))).toContain('nested too deeply');
  });

  it('replaces an oversized value with a preview', () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'y'.repeat(3000)]));
    expect(shape(big)).toMatchObject({ truncated: true });
  });
});

describe('httpCodesIn', () => {
  it('reads codes a message or result states itself, and only those', () => {
    expect(httpCodesIn('QuickBooks returned HTTP 401 Unauthorized')).toEqual(['401']);
    expect(httpCodesIn('status: 429, retry later')).toEqual(['429']);
    expect(httpCodesIn({ response: { statusCode: 503 }, count: 404 })).toEqual(['503']);
    expect(httpCodesIn('processed 404 rows')).toEqual([]);
  });
});

describe('buildSteps', () => {
  const rows = [
    row('t', 'agent.task', { content: 'Books checkpoint' }, '2026-11-03T13:00:00.000Z'),
    row('l1', 'llm.call', { actualModel: 'm-1', requestedModel: 'm', provider: 'p', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, estimatedCostUsd: 0.01, latencyMs: 800, providerRequestId: 'msg_abc' }, '2026-11-03T13:00:01.000Z'),
    row('i1', 'tool.invoke', { toolName: 'quickbooks-query', input: { q: 'select 1', access_token: 'secret' } }, '2026-11-03T13:00:02.000Z'),
    row('r1', 'tool.result', { toolName: 'quickbooks-query', result: { success: false, error: 'HTTP 401 from QuickBooks', errorType: 'AUTH_FAILURE' }, durationMs: 250 }, '2026-11-03T13:00:03.000Z', 'i1'),
    row('x', 'memory.write', { whatever: true }, '2026-11-03T13:00:03.500Z'),
    row('a', 'agent.response', { content: 'done', isError: false }, '2026-11-03T13:00:04.000Z'),
  ];

  it('pairs a tool call with its result and shows inputs, outputs and codes', () => {
    const steps = buildSteps(rows);
    expect(steps.map((s) => s.kind)).toEqual(['task', 'llm', 'tool', 'response']);   // the memory event is not a step
    const tool = steps[2]!;
    expect(tool).toMatchObject({ title: 'quickbooks-query', status: 'error', durationMs: 250, offsetMs: 2000 });
    expect(tool.input).toEqual({ q: 'select 1', access_token: '[redacted]' });
    expect(tool.output).toEqual({ error: 'HTTP 401 from QuickBooks' });
    expect(tool.codes).toEqual([
      { label: 'error type', value: 'AUTH_FAILURE' },
      { label: 'usually', value: 'HTTP 401 or 403', inferred: true },
      { label: 'HTTP', value: '401' },
    ]);
  });

  it('records the model call with its provider request id', () => {
    const llm = buildSteps(rows)[1]!;
    expect(llm).toMatchObject({ status: 'ok', durationMs: 800 });
    expect(llm.codes).toEqual([{ label: 'provider request', value: 'msg_abc' }]);
    expect(llm.output).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('keeps a call with no result yet as an open step', () => {
    const steps = buildSteps([rows[0]!, rows[2]!]);
    expect(steps[1]).toMatchObject({ kind: 'tool', status: null, durationMs: null });
  });
});

function fakePool(responses: Array<{ rows: unknown[] }>) {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { pool: { query } as unknown as Pool, query };
}

describe('JobRunHistory', () => {
  it('lists runs by the job-scoped conversation prefix and works out each outcome', async () => {
    const mk = (conv: string, responses: number, errorResponses: number, errors: number) => ({
      conversation_id: conv, started_at: new Date('2026-11-03T13:00:00Z'), ended_at: new Date('2026-11-03T13:00:05Z'),
      tool_calls: '2', tool_failures: '1', llm_calls: '3', errors: String(errors), responses: String(responses),
      error_responses: String(errorResponses), cost_usd: '0.0123',
    });
    const { pool, query } = fakePool([{ rows: [mk(`scheduler:${JOB}:${RUN}`, 1, 0, 0), mk(`scheduler:${JOB}:aaaa`, 1, 1, 0), mk(`scheduler:${JOB}:bbbb`, 0, 0, 0)] }]);
    const runs = await new JobRunHistory(pool).list(JOB, 10);
    expect(query.mock.calls[0]![1]).toEqual([`scheduler:${JOB}:%`, 10]);
    expect(runs.map((r) => [r.runId, r.outcome])).toEqual([[RUN, 'completed'], ['aaaa', 'failed'], ['bbbb', 'incomplete']]);
    expect(runs[0]).toMatchObject({ durationMs: 5000, toolCalls: 2, toolFailures: 1, llmCalls: 3, costUsd: 0.0123 });
  });

  it('never queries with an id that is not a UUID, so a wildcard cannot widen the match', async () => {
    const { pool, query } = fakePool([]);
    const h = new JobRunHistory(pool);
    expect(await h.list('%')).toEqual([]);
    expect(await h.get(JOB, '%')).toBeNull();
    expect(await h.get('x', RUN)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('caps the number of runs and ignores a nonsense limit', async () => {
    const { pool, query } = fakePool([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const h = new JobRunHistory(pool);
    await h.list(JOB, 9999);
    await h.list(JOB, Number.NaN);
    await h.list(JOB, 0);
    expect(query.mock.calls.map((c) => (c[1] as unknown[])[1])).toEqual([50, 20, 1]);
  });

  it('returns one run with its steps, and null when there are none', async () => {
    const { pool, query } = fakePool([
      { rows: [row('t', 'agent.task', { content: 'go' }, '2026-11-03T13:00:00Z'), row('a', 'agent.response', { content: 'ok' }, '2026-11-03T13:00:02Z')] },
      { rows: [] },
    ]);
    const h = new JobRunHistory(pool);
    const run = await h.get(JOB, RUN);
    expect(query.mock.calls[0]![1]).toEqual([`scheduler:${JOB}:${RUN}`, 1001]);
    expect(run).toMatchObject({ runId: RUN, outcome: 'completed', durationMs: 2000, cutOff: false });
    expect(run!.steps).toHaveLength(2);
    expect(await h.get(JOB, RUN)).toBeNull();
  });

  it('says so when a run was cut off at the row limit', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => row(`r${i}`, 'llm.call', { actualModel: 'm' }, '2026-11-03T13:00:00Z'));
    const { pool } = fakePool([{ rows: many }]);
    const run = await new JobRunHistory(pool).get(JOB, RUN);
    expect(run!.cutOff).toBe(true);
    expect(run!.steps).toHaveLength(1000);
  });
});
